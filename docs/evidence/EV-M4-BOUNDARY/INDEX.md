# EV-M4-BOUNDARY — OPUS-M4-001 solver runtime boundary and canonical input

**Task:** OPUS-M4-001 (doc 35 §6a) · **Date:** 2026-08-12 · **Branch:** `opus/m4-001-solver-boundary`
**Env:** macOS 26.5.2 arm64 · Node 22 · embedded-postgres · **CPython 3.9.6 (FAD-7 substitution; the image pins 3.12 per FAD-10)** · **no Docker daemon — `Dockerfile.solver` authored, NOT built**

---

## 1. What landed

The **boundary**, not the model. SPEC-04 §1's separately packaged Python worker, its versioned mutually-authenticated RPC, one-solve-per-subprocess with layered cancellation, and the immutable canonical input snapshot (migration `0016`). **The solve itself is a documented stub** — doc 35 §6a's "stub solver first" — so the auth, timeout, cancellation and forced-kill paths are proven before any constraint model exists. M4-002 replaces `stub_solver.py` and nothing else in the worker moves.

## 2. Command results — every number from the runner's own output

| Step | File | Result |
|---|---|---|
| `pnpm check` (1st) | `step-01-check.txt` | **EXIT=1** — 14/15; unit 19 failed. One root cause, diagnosed below |
| `pnpm check` (2nd) | `step-02-check.txt` | **EXIT=1** — 14/15; unit 3 failed (vacuity, diagnosed below) |
| `pnpm check` (3rd) | `step-03-check.txt` | **EXIT=0** — **15/15 gates**; unit **1780 passed / 139 files** |
| `pnpm red-cases` | `step-04-red-cases.txt` | **EXIT=0** — **43 cases: 43 proven, 0 not proven** (38 inherited + 5 new) |
| `pnpm fixture-regression` | `step-05-fixture-regression.txt` | **EXIT=0** — **126 runs: 126 passed, 0 failed** (fresh rotating seed) |
| `pnpm sbx` | `step-06-sbx.txt` | **EXIT=0** — 6/6 falsifiable; **329 readings across 7 contexts; 0 wrong-tenant rows; 47 of 47 tables observed** |
| Named proofs — standalone | `step-07-standalone-proofs.txt` | 10 solver files **80/80**, plus `sbx.test.ts` **17/17** |
| Named proofs — in-suite | `step-08-in-suite-proofs.txt` | `apps/api/test/solver/` **10 files, 80 tests, all passed** |
| Migration 0016 cycle | `step-09-migration-0016-cycle.txt` | up → down → up **by name**, populated, mutation control fired |
| Named proofs — full battery | `step-03-check.txt` | included in unit 1780/1780 |

### 2b. POST-REVIEW REPAIR — the authoritative run

The independent review returned **REJECT** on one blocking defect (B-1) with three
conditions and three authorized hardenings. §8 records each fix. The battery was
then re-run in full; **these are the numbers that count**:

| Step | File | Result |
|---|---|---|
| `pnpm check` | `step-10-check-post-repair.txt` | **EXIT=0** — **15/15 gates**; unit **1792 passed / 139 files** (+12 non-ASCII, none lost) |
| `pnpm red-cases` | `step-11-red-cases-post-repair.txt` | **EXIT=0** — **43 cases: 43 proven, 0 not proven** |
| `pnpm fixture-regression` | `step-12-fixture-regression-post-repair.txt` | **EXIT=0** — **126 runs: 126 passed, 0 failed** |
| `pnpm sbx` | `step-13-sbx-post-repair.txt` | **EXIT=0** — 6/6 falsifiable, **0 vacuous**; **329 readings / 7 contexts / 0 wrong-tenant / 47 of 47 tables** |

One discarded run is retained deliberately: an earlier `red-cases` attempt ended at
**319 bytes, case 3 of 43, with no `EXIT=` line**. The launcher reported success; the
battery had not. The missing marker is what caught it, and the result was thrown away
rather than reported — see §9.

### 2a. The 48-vs-47 table count, reconciled

`TENANT_TABLES.length` is **48**; the SBX-004 sweep reports **47 of 47**. Both are correct and they are different populations: `probeUnder` skips the single table whose scope is `through-membership` — **`users`**, global by PO-DEC-06 and reached *through* a membership, so "wrong tenant" is not a column comparison for it and it gets a dedicated probe instead. **`sweep = registry − 1`, permanently.** Main was 47 registry / 46 sweep; `solver_input_snapshots` adds exactly one to each. The floor assertion in `sbx.test.ts` is over the **registry** (`>= 48`) and now carries a comment naming both counts, because conflating them is what produced two wrong predictions during this task.

## 3. The two defects this task caused, and their mechanisms

**(1) A positional migration count, third occurrence.** `schedule/migration-0014-populated-cycle.test.ts` reversed by `count: 2`. With `0016` on disk the two migrations above 0014 are 0016 and 0015, so the step **never touched 0014**; the by-name assertion then threw **between the down and the up**, leaving the shared cluster short of 0015 *and* 0016 for every later file. That single fact produced all 19 failures (`column "operation_type" does not exist`, `relation "solver_input_snapshots" does not exist`, `rule_revisions` gone, `TENANT_TABLES` naming a dropped table). **Fixed by making the loop's termination condition the NAME** — roll down one at a time until the target comes down — and, more importantly, by putting the re-up in a `finally`. The wrong count was only the trigger; the blast radius came from the assertion in between. Both cycle tests now use the idiom.

**(2) Sweep vacuity in two fixtures.** `solver_input_snapshots` was registered but seeded only in `sbx.test.ts`. Under FAD-15 each file owns its tenant, and `probe-is-not-vacuous.test.ts` / `tenancy/unit-of-work.test.ts` each seed their own sweep rows — they call `seedRulesForSweep` **and** `seedLocationsForSweep` for exactly this reason. Fixed by adding the third seeder call to both, through the **production path** (`assembleCanonicalInput` → `persistCanonicalInput`), the `rule_revisions` precedent. Nothing was removed from `TENANT_TABLES`; no probe was weakened.

## 4. Falsifiability — the five new red cases

| Case | Violation introduced | Proven |
|---|---|---|
| `solver-provider-in-transaction` | dispatch moved inside the assembly transaction | pass / fail |
| `solver-snapshot-immutability` | append-only trigger removed **and** UPDATE/DELETE granted | pass / fail |
| `solver-outcome-honesty` | the H-6 status/reason rule always agrees | pass / fail |
| `solver-rpc-request-auth` | worker-side request MAC comparison removed | pass / fail |
| `solver-response-auth` | platform-side response MAC verification always agrees | pass / fail |

`solver-outcome-honesty` compiles its violation into `packages/domain/dist`, which every later case consumes, so it carries a `restore` step. **Verified after the run rather than assumed:** source and dist both contain zero `red case` remnants, and `sha256(dist/src/ports/solver-port.js)` is **identical before and after a forced rebuild** (`3940fb29…`) — so the four cases that ran after it were judged against clean code.

## 8. Post-review repairs

| Finding | Mechanism | Proof |
|---|---|---|
| **B-1 (blocking)** — the MAC covered a *re-derivation* of the message, not the bytes sent. Platform signed `canonicalStringify` (raw UTF-8); worker re-derived `json.dumps(ensure_ascii=True)` (`\uXXXX`). Identical for ASCII, different for everything else | The wire is now **framed** — `<auth line>\n<body bytes>` — the tag travels beside the body, the auth metadata sits in the MAC prefix, and **neither side re-serialises to verify**. The webhook-signature pattern; maps to HTTP unchanged | 6/6 non-ASCII cases round-trip AND authenticate both directions (`worker-round-trip`, `rpc-auth`) |
| **C-1** — two pre-auth crash paths wrote no response and surfaced as `FAILED/killed` with raw tracebacks | `mac` validated as 64-hex **shape** before `compare_digest` (which raises `TypeError` on non-ASCII `str`); `RecursionError` caught beside `ValueError` | non-ASCII mac → `exit 2`, `unauthenticated`, no traceback; 60,000-deep JSON → `exit 2`, `malformed_json`, no traceback |
| **C-2** — `FAILED/killed` attributed to three situations, two of them not kills | `signal !== null` ⇒ `killed`; spawn-failure and exit-without-response ⇒ `crashed` (SPEC-04 §2 has both words) | `response-refusals` asserts `crashed`; `worker-lifecycle` still asserts `killed` for the genuine signal kill |
| **C-3** — the down-loop's own `throw` sat OUTSIDE the try, so its failure still skipped the `finally` re-up | Loop moved inside the try in **both** cycle files; `down.length` read in the `finally`, so however far it got, exactly that many go back up | Reviewer's `/0099/` mutation reproduced: **1 failed / 22 passed** — one test fails, no downstream poisoning |
| **N-3** | `_socket.socket` stubbed (the C accelerator behind the wrapper); scanner regex widened to `_?socket` | both `socket.socket` and `_socket.socket` verified blocked |
| **N-5** | three phantom test citations corrected, plus a sweep | every remaining `*.test.ts` citation resolves to a real file |
| **N-6** | `SOLVER_PACKAGE_ROOT` walks up to find `solver/schedulepoint_solver` instead of counting `..` (the fixed depth was wrong for the `dist` layout) and throws loudly when absent | `typecheck` + full battery |

### 8a. Red-case RE-ANCHORING — a consequence of the B-1 repair

B-1 deleted the code two arms anchored into. Rather than fix only the arm the runner
reported, every `{file, find, replace}` triple in `run.mjs` was extracted and tested
against the tree: **32 anchors, 2 broken** — `solver-rpc-request-auth` and
`solver-response-auth`, both pointing into the rewritten verification path. After
re-anchoring: **32 checked, 0 broken**.

The new violations remove the **equivalent** check in the repaired code, so each arm
still proves what its name says — the worker-side raw-byte `compare_digest` and the
platform-side `timingSafeEqual` respectively — and both deliberately leave every
*shape* check standing, so they falsify authentication rather than the parsing around
it. Verified standalone before the full run:

```
solver-rpc-request-auth   GREEN 14/14 passed   RED 1 failed | 13 passed
solver-response-auth      GREEN 14/14 passed   RED 2 failed | 12 passed
```

### 8b. N-1 — recorded, NOT fixed (stated limitation)

The review confirmed the limitation is stated accurately, so it is recorded here rather
than repaired: **the tz database is the runtime's, and there is only one of it.**
`schedule_versions.tzdb_version` and the snapshot's `timezone.tzdbVersion` make a
divergence **detectable**; they do not make an old interpretation **reproducible**. A
build recorded under `2026b` cannot be re-derived under `2027a` — the record says which
rule set was in force, and nothing here pretends more than that.

Also out of scope by direction, recorded for later: **N-2** (the static gate belongs to
000C; modifying existing gates is prohibited, and the runtime guard covers the shapes
the scan cannot see), **N-4**, **N-7** (TRUNCATE guards would touch prior migrations).

## 9. Process note — a discarded battery result

An earlier `red-cases` run reported exit 0 from its launcher while its evidence file
held **319 bytes and stopped at case 3 of 43, with no `EXIT=` line**. The marker is
appended only when the runner itself finishes, so its absence is the detector. The run
was re-executed under `nohup`/`disown` rather than reported. **"43/43 proven" off a
three-case transcript would have been a fabricated result**, and the cheap convention of
appending `EXIT=$?` is what made it impossible to report by accident.

## 5. Worker runtime record (SPEC-04 §4, as amended by FAD-10)

```
imageDigest          venv:/Applications/Xcode.app/.../python3   ← recorded ABSENCE, never fabricated
solverVersion        stub-1+stub-only                            ← OR-Tools absent; not pretended consulted
compilerVersion      0
platformArch         darwin-arm64
languageRuntime      cpython-3.9.6
reproducibilityMode  COMPUTED from parameters, never declared
```

**The image was not built** (FAD-7: no Docker daemon). `Dockerfile.solver` is authored at the repository root, pins `python:3.12-slim-bookworm` and `ortools==9.15.6755` by exact version. **Building it and recording its digest is the standing CI condition** FAD-10 attached to E0 closure. No claim is made about a built artifact.

## 6. Files

```
step-01-check.txt … step-09-migration-0016-cycle.txt   the runs above, each with its EXIT line
INDEX.md                                                this file
```

## 7. What is NOT claimed

- **No benchmark.** No corpus has been run; every performance statement is a measurement of the *stub*, not of a solver.
- **No reproducibility claim** for any run: the FAD-7 environment has no image digest, so `imageDigest` is an absence and `deterministic` mode is only ever a statement about the *parameters*.
- **No OR-Tools behaviour is verified here.** M4-001 imports it nowhere; the ADR-0006 one-module allowance is deliberately unspent so M4-002's adapter is the first importer.
- Numbers measured under CPython 3.9.6 are numbers measured under 3.9.6. The 3.12 re-run remains a CI condition.
- **Historical tz interpretations are not reproducible** (N-1, §8b): the recorded `tzdb_version` makes a divergence detectable, not re-derivable.
