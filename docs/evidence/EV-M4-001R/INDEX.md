# EV-M4-001R — the FAD-28 contract-statement correction, and the inertness proof

**Packet:** OPUS-M4-001R (doc 35 §6b), finalized 2026-08-13.
**Branch:** `opus/m4-001r-fad28-correction`, base commit `fb4b72b`.
**Rulings consumed:** FAD-28(2) · FAD-33(1) · FAD-35 · FAD-27 · FAD-15.

This packet changed **no behaviour**. It corrected one false statement, corrected
one citation, and landed the runnable proof that the statement's replacement is
true.

---

## 1. What shipped

| Clause (§6b Required behaviour) | Change |
|---|---|
| **(1)** the docblock states FAD-28's contract precisely | `apps/api/src/profiles/qualifications.ts` — `grantHolding`'s docblock. The sentence "the granted-while-retiring race is closed by the trigger inside the same transaction as the retirement's committed state" is replaced by a section that states the admission, names the duplicate-issue constraint that IS load-bearing (`qualification_holdings_unique_issue`), and locates the safety property in the shared verdict's lifecycle-first `retired` outcome. It also records that the earlier revision claimed the opposite and was falsified — the correction is visible rather than silent |
| **(2)** the new proof | `apps/api/test/profiles/granted-while-retiring-inertness.test.ts` (new). Reproduces probe P3e on two real connections through the real services, then asserts (a) admission, (b) manual path, (c) publication path, (d) canonical solver input |
| **(3)** falsifiability per FAD-33(1) | Option (b) taken: the new file is added to the `retired-verdict` red case's `greenCommand` and `redCommand` lists in `scripts/red-cases/run.mjs`. That case already rebuilds `packages/domain` between the patch and the run, so the api-side proof observes the patched `dist`. Verified standalone in both directions (§4) |
| **(3, citation)** FAD-30 → FAD-33(1) | The `retired-verdict` case's repair comment cited the decorative-arm standing rule as FAD-30; its true number is FAD-33(1). One word changed; the case's mechanics are otherwise untouched except for the two added test paths and a new paragraph recording the extension |
| **(4)** the M4-002 carry-forward | Recorded in §6 below. **Nothing solver-side was implemented.** |

### Files changed (the complete diff surface)

```
 M apps/api/src/profiles/qualifications.ts          docblock only, no statement changed
 M scripts/red-cases/run.mjs                        citation + the retired-verdict test lists
 A apps/api/test/profiles/granted-while-retiring-inertness.test.ts
 A docs/evidence/EV-M4-001R/**
```

Every one of these is inside the packet's Allowed files. Nothing else was
touched — expressly not `packages/domain/src/eligibility/**` (frozen), no
migration, no gate, no `solver/**`, no `apps/web/**`, no
`docs/{architecture,fable}/**`.

---

## 2. The contract, as it now reads

FAD-28 R1 refuses a NEW holding of a retired qualification at two layers — the
service (`QUALIFICATION_RETIRED`, 422) and migration 0012's trigger
`qualification_holdings_guard_expiry_retirement`. **Neither is a write-time
exclusion under concurrency.** Under READ COMMITTED a grant whose lookups
returned `active` still commits after a retirement has committed on another
connection.

The safety property is supplied by the READ side: the shared verdict evaluates
the qualification's lifecycle FIRST (ruling R3) and answers `retired` even over
an in-window `valid` holding. So the interleaving is admitted and the credential
it produces is inert — for the manual eligibility read, for the publication
gate, and for canonical solver-input assembly.

That is what the corrected docblock says, and §3 is what makes it measured
rather than asserted.

---

## 3. How the interleaving is reproduced deterministically — with no stub, no
## hand-rolled statement, and no sleep

The obvious ordering (hold the grant open, commit the retirement beside it)
cannot be built from the shipped services, and the reason is load-bearing:

- every mutation here writes an audit row, and migration 0003's
  `app_audit_assign_chain` takes a **per-organization transaction-scoped
  advisory lock** (plus the chain-head tip row) before assigning a sequence;
- so a grant transaction that has reached its audit insert holds that lock until
  it commits, and a retirement in the same organization could never commit
  beside it.

Reversing the pair produces the interleaving exactly, with the lock doing the
synchronisation:

1. the RETIREMENT transaction runs `setQualificationStatus` and stops before
   commit. It holds the audit advisory lock; its `UPDATE` holds `FOR NO KEY
   UPDATE` on the qualification row, which does **not** conflict with the
   `FOR KEY SHARE` the holding's foreign key will take;
2. the GRANT transaction runs `grantHolding`. Its service lookup and 0012's
   trigger both read the qualification under READ COMMITTED, both see `active`,
   and the holding row is inserted. The grant then **blocks** at its own audit
   insert;
3. the test observes that block directly in `pg_stat_activity` (superuser, and
   only as harness observation) and asserts the grant has **not** settled. That
   is the ordering proof: the grant cannot commit until the retirement releases
   the lock, i.e. until the retirement has committed;
4. the retirement is released and commits; the grant commits behind it.

Measured on the standalone run (`02-named-proof-standalone.txt`):

```
· race established: grant backend 23750 blocked on Lock/advisory held by
  retirement backend 23749
· admitted: one committed holding of a now-retired qualification, status valid
· manual path: raced=retired, control=satisfied
· publication path: retired finding reported, and the step-06 prerequisite refused
· solver input: raced pair retired/ineligible, control pair satisfied/eligible
```

Ground truth is read with the superuser: `count(*) = 1` holding of the raced
qualification for the assignee, `status = 'valid'`, and
`qualifications.status = 'retired'` — the review's `committedHoldings=1,
qualification=retired`, measured here rather than cited.

**The control.** The same period and the same draft version carry a SECOND shift
type and a SECOND qualification whose holding was granted with no race at all,
and every consumer is asked about both in the same read. `retired` on one and
`satisfied` on the other is what makes the assertions live — a consumer that
answered `retired` for everything would fail the control.

**Fixture ownership (FAD-15).** The tenant is the file's own (`ownedMulti`
slug `granted-while-retiring-inertness`); every shift type, qualification,
period, version, assignment and holding is created by the file; the shared MULTI
baseline is not touched. The race runs once in `beforeAll` because it is the
file's single subject, and every `it` afterwards is a pure READ of the state it
produced — so no case can disturb another and file- or test-order shuffle cannot
change an outcome.

---

## 4. Falsifiability — both directions, verified standalone

The `retired-verdict` case patches `packages/domain/src/eligibility/verdict.ts`,
replacing rule 1 (`if (lifecycle !== 'active') return 'retired';`) with a
compile-clean `void lifecycle;`, rebuilds `packages/domain`, and runs the listed
tests. Run by hand, with the case's own patch/prepare/redCommand:

| Arm | Command | Result | Exit |
|---|---|---|---|
| **GREEN** (clean tree) | `corepack pnpm exec vitest run packages/domain/test/eligibility/verdict.test.ts apps/api/test/profiles/verdict-convergence.test.ts apps/api/test/profiles/granted-while-retiring-inertness.test.ts` | 3 files passed, **36 tests passed** | `0` |
| **RED** (rule 1 removed, domain rebuilt) | same command, after the patch + `tsc -b packages/domain --force` | **3 files failed, 7 failed / 29 passed** | `1` |

Transcripts: `03-retired-verdict-arm-green.txt`, `04-retired-verdict-arm-red.txt`.

The seven RED failures, named:

```
FAIL |domain| verdict.test.ts > retired: the qualification lifecycle decides FIRST, over a live holding
FAIL |domain| verdict.test.ts > retired: an unresolvable lifecycle is fail-closed retired, never satisfied
FAIL |domain| verdict.test.ts > MUTATION CONTROL … a retirement-last variant is caught by the retired oracle
FAIL |api|    granted-while-retiring-inertness.test.ts > (b) MANUAL PATH …
FAIL |api|    granted-while-retiring-inertness.test.ts > (c) PUBLICATION PATH …
FAIL |api|    granted-while-retiring-inertness.test.ts > (d) SOLVER INPUT …
FAIL |api|    verdict-convergence.test.ts > RETIRED agrees across both consumers, and outranks the holding
```

Arm **(a)** of the new file passes under the violation, and that is correct and
deliberate: the admission is a fact about the *database*, not about the verdict,
so removing the verdict's rule must not change it. All three *consumer* arms
bite. The patch was reverted with `git checkout --` and `packages/domain`
rebuilt clean before the battery.

---

## 5. Commands run — actual results

Every command run serially in the worktree, each transcript ending in its own
`EXIT=` line taken from `$?`.

| # | Command | Result | Exit | Transcript |
|---|---|---|---|---|
| 1 | `corepack pnpm install` | up to date, 467 packages | `0` | `01-install.txt` |
| 2 | `corepack pnpm exec vitest run apps/api/test/profiles/granted-while-retiring-inertness.test.ts` | 1 file, **4 tests passed** | `0` | `02-named-proof-standalone.txt` |
| 3a | the `retired-verdict` GREEN arm, standalone | 3 files, 36 passed | `0` | `03-retired-verdict-arm-green.txt` |
| 3b | the `retired-verdict` RED arm, standalone | 3 files failed, 7 failed | `1` | `04-retired-verdict-arm-red.txt` |
| 4 | `corepack pnpm check` | **15/15 gates PASS**; unit 140 files / **1796 tests** | `0` | `06-check.txt` |
| 5 | `corepack pnpm red-cases` | **43 case(s): 43 proven, 0 not proven** | `0` | `07-red-cases.txt` |
| 6 | `corepack pnpm fixture-regression` | **127 run(s): 127 passed, 0 failed** | `0` | `08-fixture-regression.txt` |
| 7 | `corepack pnpm sbx` | 6 scenarios, 0 vacuous; **329 readings / 47 of 47 tables / 0 wrong-tenant** | `0` | `09-sbx.txt` |
| 8 | `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | **0001–0016, cycle clean** | `0` | `10-migrate-cycle.txt` |
| — | the write-time-exclusion sweep | see §5b | `0`/`1` per grep, annotated | `05-write-time-exclusion-sweep.txt` |

### 5a. Battery results, in the transcripts' own words

**`pnpm check` — 15/15.** `lint · typecheck · unit · import-boundary · route-policy ·
migration-rls · invariant-ids · rule-node-mapping · rule-kind-registry ·
provider-boundary · secret-scan · build · network-guard · axe · request-budget`, all
`PASS`. The unit gate: `Test Files 140 passed (140) / Tests 1796 passed (1796)` — 1792
before this packet, plus this file's 4.

**`pnpm red-cases` — 43/43 PROVEN**, including the extended arm:

```
retired-verdict                     pass   fail   PROVEN
43 case(s): 43 proven, 0 not proven
```

Count unchanged at 43: this packet added test files to an existing case rather than a
case.

**`pnpm fixture-regression` — 127/127**, fresh rotating seed:

```
2. ROTATING SEED — this run drew 11742
PASS  rotating seed 11742    56.2s  1209 passed (1209)
...
127 run(s): 127 passed, 0 failed
Order-independent under every seed tried.
Every file also passes alone.
The shared baseline was unmodified in every run (the Layer 1 control runs in each).
```

The 14 fixed seeds and the rotating seed each ran 1209 api tests with file AND test
order shuffled; the standalone sweep ran every file alone. The new proof file is in all
of them, and the FAD-15 Layer-1 baseline-immutability control passed in each — this
packet's fixture touches nothing shared.

**`pnpm sbx` — floor unchanged.** 6 scenarios, every contract complete, `vacuous
assertions detected: 0`, audit chain clean. SBX-004:

```
API arm: 95 registered organization-scoped route(s) swept …
SQL arm: 47 tenant table(s) swept directly, as five roles.
readings: 329 (role, context, table) readings across 7 contexts; 0 wrong-tenant rows;
47 of 47 tables observed with visible rows
```

Byte-identical to the floor EV-M4-BOUNDARY §2b records (329 / 47 of 47 / 0). No table was
added, so unchanged is the correct outcome, not a missed raise.

**Migration cycle 0001–0016.** All sixteen applied by name, then
`MIGRATION CYCLE CLEAN — up -> down -> up -> down -> up, 1175ms`, `cluster: stopped`.

**Contention:** none observed. No test FILE failed with tests skipped, and the R-B4a
enumeration did not time out in any run. Both known transient signatures were absent, so
nothing was re-run to make it pass.

### 5b. The repo-wide sweep

`05-write-time-exclusion-sweep.txt` is the retained sweep for surviving
write-time-exclusion claims. After the correction the only occurrences of the
falsified wording are **historical records that are correct as history**:
`docs/evidence/EV-M4-INPUT-A/INDEX.md` §8 and §10 C3 (which state that the claim
was wrong), `docs/fable/35-m4-task-packets.md` §6b and
`docs/fable/control/ARCHITECTURE-DECISIONS.md` FAD-35 (which quote it in order to
correct it). **No source file asserts write-time exclusion.**

---

## 6. The M4-002 carry-forward — RECORDED, NOT IMPLEMENTED

Per §6b clause 4 and FAD-35(c). Nothing solver-side was written by this packet.

1. **The independent candidate validator must consume the shared verdict.**
   M4-002's validator is required to be independent of the solver's constraint
   implementation — it must not become independent of the *eligibility* rule as
   well. A validator with its own lifecycle arithmetic is the S-01 shape, and
   this packet's proof is exactly what a second spelling would silently
   contradict: the raced holding is inert only because one function evaluates
   lifecycle first.
2. **The E1 corpus must include a race-produced retired-holding fixture the
   validator rejects.** A candidate that staffs the raced membership on the
   raced shift type must be rejected by the independent validator, and the
   fixture must be produced by the same interleaving this file reproduces (or by
   a snapshot captured from it), not by hand-writing a retired qualification with
   a live holding — a hand-built fixture proves the validator handles a state
   the system might never reach.

Both belong in OPUS-M4-002's packet body. This packet records them and stops.

---

## 7. Honest notes and limitations

- **No behaviour changed.** The docblock is a comment; `run.mjs`'s edits are a
  citation and two test paths. `git diff` over `apps/api/src` contains no
  statement change, and `pnpm check`'s typecheck and unit gates ran over the
  result.
- **The determinism depends on the audit chain's per-organization
  serialisation.** That is stated in the test's own docblock, and the dependency
  is fail-loud: if the audit chain ever stopped serialising, the grant would not
  block, `waitUntilBlockedOnLock` would raise with the last observed wait state,
  and arm (a)'s `grantSettledWhileRetirementOpen` assertion would fail. The file
  cannot silently start measuring an ordinary sequential grant.
- **The proof covers the three consumers that exist today.** Manual read,
  publication gate, canonical solver input. The independent candidate validator
  does not exist yet — that is the §6 carry-forward, not a gap this packet could
  close.
- **`pg_stat_activity` is read with the superuser client**, which is harness
  observation only (`admin-client.ts` states the rule). No assertion about
  application behaviour is satisfied by a superuser read; the ground-truth
  holding/qualification counts in arm (a) are deliberately superuser reads
  *about the database*, which is what "the admission is real" means.
- **Nothing here weakens an existing test.** The `retired-verdict` case gained a
  third test file in both arms; no assertion was removed or relaxed anywhere.
