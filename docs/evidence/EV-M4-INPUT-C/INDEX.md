# EV-M4-INPUT-C — OPUS-M4-000C

**Rule revisioning and registry, publication handoff, provider-outside-transaction control.**
Doc 34 §4-D, §4-G, §4-H; doc 35 §5. Branch `opus/m4-000c-rules-publication-provider`,
worktree `.worktrees/m4-000c`, from `a0f1bcc`.

Migration number **0015** and prohibited range **0001–0014** per doc 35 §2 as amended
2026-08-10 (FAD-30). Migration 0014 belongs to OPUS-M4-000B and does not exist on this
branch; the cycle below runs 0015 correctly without it, and §2's renumber-at-merge
provision governs composition.

---

## 1. The battery, in order, with real counts

Every capture retains its full output. **The two failed check runs are retained
deliberately** — a discarded failure without a recorded diagnosis is how a signature gets
normalized (the M4 entry record's own words about the preview-port contention).

| # | File | Command | Result |
|---|---|---|---|
| 00 | `step-00-install.txt` | `corepack pnpm install` | EXIT=0 |
| 01 | `step-01-new-db-proofs.txt` | `vitest run` revision-and-cas + providers/boundary | **19/19**, EXIT=0 |
| 02 | `step-02-handoff-proof.txt` | `vitest run` publication-handoff | **17/17**, EXIT=0 |
| 03 | `step-03-check.txt` | `corepack pnpm check` | **EXIT=1 — 12/15.** Retained. Diagnoses in §2 |
| 04 | `step-04-check-rerun.txt` | `corepack pnpm check` | **EXIT=1 — 14/15.** Retained. Diagnosis in §2 |
| 05 | `step-05-check-rerun2.txt` | `corepack pnpm check` | **EXIT=0 — 15/15 gates; unit 120 files / 1504 tests** |
| 06 | `step-06-red-cases.txt` | `corepack pnpm red-cases` | **EXIT=0 — 30 cases, 30 proven, 0 not proven** |
| 07 | `step-07-fixture-regression.txt` | `corepack pnpm fixture-regression` | **EXIT=0 — 110 runs, 110 passed.** 13 fixed seeds + **rotating seed 914654**, 1040 tests each |
| 08 | `step-08-sbx.txt` | `corepack pnpm sbx` | **EXIT=0 — 6/6 scenarios, 0 vacuous.** SBX-004: 322 readings / 7 contexts / **0 wrong-tenant rows** / **46 of 46 tables** visible |
| 09 | `step-09-migration-cycle.txt` | `migrate:cycle:embedded` | **EXIT=0 — CYCLE CLEAN**, up→down→up→down→up, 14 migrations each direction incl. 0015 |
| 10 | `step-10-named-proofs.txt` | named proofs standalone + in-suite | **EXIT=0** — see §4 |
| — | *independent review returned ACCEPT WITH CONDITIONS* | — | condition closure below, §6 |
| 11 | `step-11-closure-check.txt` | `corepack pnpm check` | **EXIT=0 — 15/15; unit 120 files / 1512 tests** |
| 12 | `step-12-closure-red-cases.txt` | `corepack pnpm red-cases` | **EXIT=0 — 31 cases, 31 proven, 0 not proven** |
| 13 | `step-13-closure-fixture-regression.txt` | `corepack pnpm fixture-regression` | **EXIT=0 — 110 runs, 110 passed.** Fresh **rotating seed 765249**, 1048 tests each |
| 14 | `step-14-closure-sbx.txt` | `corepack pnpm sbx` | **EXIT=0 — 6/6, 0 vacuous.** 322 readings, **0 wrong-tenant**, **46/46 tables** |
| 15 | `step-15-closure-named-proofs.txt` | named proofs standalone + in-suite | **EXIT=0** — see §4 |
| — | *SECOND-MERGER INTEGRATION — rebased onto main `a614f7e` (000B merged first)* | — | composition record, §8 |
| 16 | `step-16-rebase-check.txt` | `corepack pnpm check` | **EXIT=1 — 14/15; 8 unit failures.** Retained. Diagnoses in §8 |
| 17 | `step-17-rebase-check2.txt` | `corepack pnpm check` | **EXIT=0 — 15/15; unit 129 files / 1700 tests** |
| 18 | `step-18-rebase-red-cases.txt` | `corepack pnpm red-cases` | **EXIT=0 — 38 cases, 38 proven, 0 not proven** |
| 19 | `step-19-rebase-fixture-regression.txt` | `corepack pnpm fixture-regression` | **EXIT=0 — 116/116**, rotating seed **242304**, 1113 each |
| 20 | `step-20-rebase-sbx.txt` | `corepack pnpm sbx` | **EXIT=0 — 6/6, 0 vacuous**, 322 readings, **0 wrong-tenant**, **46/46 tables** |
| 21 | `step-21-rebase-migration-cycle.txt` | `migrate:cycle:embedded` | **EXIT=0 — CYCLE CLEAN**, **15 migrations each direction** (0001..0015) |
| 22 | `step-22-rebase-named-proofs.txt` | named proofs standalone + in-suite | **EXIT=0** — see §4 |

`pnpm check` is **fifteen** gates now: the thirteen standing ones plus this packet's
`rule-kind-registry` and `provider-boundary`.

---

## 2. The failures that were found, and what each actually was

Recorded because two of the four were **true positives against this packet's own code**,
and a return report that only listed green runs would have hidden the more useful half of
the evidence.

### 2a. `step-03-check.txt` — 3 gates failed

| Failure | What it actually was |
|---|---|
| `loader-is-the-only-selector` MUTATION | **A REAL DEFECT IN THIS PACKET.** `schedule/review-identity.ts` issued its own `effective_from <= now() AND (effective_to IS NULL OR effective_to > now())` and its own `qualification_holdings` join — a SECOND spelling of the in-force window rule, which is the S-01 defect the scanner exists to catch. Fixed by going through `profiles/in-force-loader.ts`, scoped to the memberships the version involves. **The scan was not touched**; adding the module to its allow-list would have been weakening a control |
| `publication-http` superseded comparison | **A REAL BEHAVIOURAL FINDING, not a test defect.** The M3 seed has moved a credit between V1 and V2 since M3-003. The old diff compared participant and instants only, so that credit move produced **no change row, notified nobody, and did not move the review digest**. The expectation grew from `['reassigned']` to `{'reassigned','amended'}` with `materialFields: ['credit']` — strictly stronger |
| `publication-diff-parity` kind union | The one place the module's kind union is written out by hand, so it is exactly what must move when a kind is added. While fixing it, a **vacuous perturbation** was found: `'a swapped membership'` perturbed `changes[0]` unconditionally, and the new `amended` change has `from === to`, so the swap was a no-op and the falsifiability check passed while perturbing nothing. It now selects a change with two distinct memberships and asserts one exists |
| `axe` FAIL (1133s) + `request-budget` 9 violations | **One root cause, and not port contention.** The e2e fixtures lacked the newly-required contract fields (`RuleView.version`, `AssignmentChange.materialFields`, `AffectedMember.amended`), so the zod parse failed, nothing rendered, and every interaction timed out at 30s. Port hygiene checked at the time: the only Playwright processes on the machine belonged to `.worktrees/m4-000b` on its own derived port; none of this worktree's |

### 2b. `step-04-check-rerun.txt` — 1 gate failed

`no-tenant-access-outside-unit-of-work` (I-15). **A false positive of a per-line
heuristic.** The tenant-table detector is
`['"`][^'"`]*\b(?:from|into|update|join)\s+<table>` applied per line — it wants a quoted
literal *before* the table name, because that is the shape of a one-line
`client.query('select … from memberships')`. The catalogue-revisions query matched only
because of its own `'shift_type'` / `'location'` discriminator literals.

Substantively **not** an I-15 breach: every statement in that module runs through
`uow.query` inside the caller's transaction, and none of the three connection detectors
fires. `publication.ts` names `publication_records` and `version_supersessions` in raw SQL
and is likewise unflagged, because those lines carry no preceding quote.

Two fixes rejected: adding the module to `CONNECTION_OWNERS` (it is not one, the `reason`
field would have been untrue, and an entry there suppresses the **connection** detectors
too), and moving `FROM` onto its own line (dodges the regex, leaves the shape). Both
tables are typed in `Database`, so they are now read through the **Kysely builder** — no
raw statement was ever needed, the hand-written `UNION ALL` is gone, and the reads are
schema-checked.

---

## 3. Red cases — the five this packet adds

All **31** proven (`green=pass / red=fail`); the 26 standing arms were not disturbed.
(The fifth, `provider-boundary-owns-connection`, closes review note N-1 — see §6.)

| Case | Violation injected | Proven |
|---|---|---|
| `rule-kind-registry` | one count hand-edited in the committed registry (`11` → `10`) | yes |
| `provider-boundary-unguarded` | a declared `@provider-port` module whose entry point does not open with the guard | yes |
| `provider-boundary-in-transaction` | a provider called from inside a `runner.run(...)` callback | yes |
| `provider-boundary-owns-connection` | a declared provider module that imports the unit-of-work runner (gate class 3) | yes |
| `provider-boundary-runtime-mutation` | **the runtime guard neutered**, marker/probe/static gate left intact | yes |

The mutation case is the load-bearing one for §4-H: it leaves the *static* gate green and
takes `apps/api/test/providers/boundary.test.ts` red, which is what proves the **runtime**
arm — not the lint — catches the captured closure, the dynamic import and the lookup
table. A runtime guard observed only passing would be decorative.

---

## 4. The named proofs, three ways

Re-measured on the COMPOSED tree (`step-22-rebase-named-proofs.txt`).

| Proof | Standalone | In-suite | Full battery |
|---|---|---|---|
| `packages/domain/test/ports/provider-boundary.test.ts` | 5/5 | ✓ | ✓ |
| `packages/domain/test/rules/registry-and-bounds.test.ts` | 15/15 | ✓ | ✓ |
| `apps/api/test/providers/boundary.test.ts` | 10/10 | ✓ | ✓ |
| `apps/api/test/rules/revision-and-cas.test.ts` | 9/9 | ✓ | ✓ |
| `apps/api/test/schedule/publication-handoff.test.ts` | 25/25 | ✓ | ✓ |
| **Totals** | **64 tests, 5 files** | **385 tests, 33 files** | **1700 tests, 129 files** |

## 5. The generated rule-kind registry

`packages/domain/src/rules/rule-kind-registry.generated.md`, emitted by
`renderRuleKindRegistry` from four **code** sources — `RULE_NODE_KINDS`,
`EVALUATED_HARD_RULE_KINDS`, `NOT_EVALUABLE_REASONS`, `RULE_KIND_METADATA`. The gate
byte-compares the committed artifact against a fresh render and independently re-asserts
the partition.

| Measure | Value | Derived from |
|---|---|---|
| Unique kinds | **30** | `RULE_NODE_KINDS` |
| Evaluated | **6** | `EVALUATED_HARD_RULE_KINDS` |
| Not-evaluable | **24** | `NOT_EVALUABLE_REASONS` keys |
| `grouping-unit-not-pinned` | 3 | reason-class prefix |
| `semantics-not-pinned` | **8** | reason-class prefix — **step-06 §3b typed 7** |
| `identifier-domain-not-pinned` | 3 | reason-class prefix |
| `constrains-the-search-not-the-content` | **6** | reason-class prefix — **step-06 §3c typed 7** |
| `data-not-modelled-at-m3` | 4 | reason-class prefix |
| One ruling away | **11** | `pendingRuling.rulingAlone` — **step-06 §5 prose typed 10 while its own table summed to 11** |
| Awaiting later-milestone input | 6 | `evaluationOwner` |
| Distinct pending rulings | 11 | `RK-RULING-01..11`, stable ids |

---

## 6. Independent review — condition closure

Verdict **ACCEPT WITH CONDITIONS**, no blocking findings; every behavioural probe held.
One condition and two notes were closed on this branch.

### C-1 — the material-input digest proof covered 3 of its claimed 9 classes

The docblock said *"each of the nine input classes is moved ONE AT A TIME and the digest
must move"* and proved three (`ruleRevisions`, `demand`, `timezone`). The reviewer showed
the other six could each be replaced by a constant with the suite green.

**The sharper half of the finding: two of the six could not have bitten at all.**
`profiles` and `qualifications` are read per **involved** membership, and "involved"
derives from the version's assignments and credits — so against a version with no
assignments both classes are empty, and no profile or credential change can move them.
That is correct by design (a profile change for somebody who is not on this schedule
cannot affect this publication) and it is exactly why the matrix fixture now carries real
assignments. The claim was not merely unproven; against that fixture it was unprovable.

**The nine-class matrix — every arm asserts BOTH halves.**

| # | Class | Mutation | Class moved | Composite moved |
|---|---|---|---|---|
| 1 | `assignments` | pin an assignment | ✓ | ✓ |
| 2 | `credits` | move a credit to a non-assignee | ✓ | ✓ |
| 3 | `conflicts` | record an `info` conflict | ✓ | ✓ |
| 4 | `ruleRevisions` | author a rule (schedule unchanged) | ✓ | ✓ |
| 5 | `catalogueRevisions` | revise a shift type | ✓ | ✓ |
| 6 | `profiles` | work profile for an **involved** membership | ✓ | ✓ |
| 7 | `qualifications` | holding for an **involved** membership | ✓ | ✓ |
| 8 | `demand` | period requirement | ✓ | ✓ |
| 9 | `timezone` | group timezone | ✓ | ✓ |

The **second** column is what makes it a matrix rather than nine smoke tests: a class that
moved its own digest without moving the composite would be a class the compare-and-set
silently ignores — healthy in isolation, invisible to the CAS. A tenth arm pins the matrix
to `MATERIAL_INPUT_CLASSES` so a later class cannot be added unfalsified while the block
still claims "every", and an eleventh asserts the digest is stable when nothing moves (it
is not a clock). The docblock now claims exactly what is proven and records that it once
claimed more.

`publication-handoff.test.ts`: **25/25**.

### N-1 — gate class 3 had no red case

Classes 1 and 2 of `provider-boundary-check` had red cases; class 3 (a provider importing
the unit-of-work runner) did not. It is not decoration: **a provider that can open a
transaction can put itself inside one, and then class 2 has nothing to see** — the illegal
call is no longer at a call site in another module's unit-of-work callback, it has been
folded into the provider. The fixture's guard is present and correctly placed, so the gate
must fail on the runner import **alone** (verified: one violation, then clean PASS).
Red-case count 30 → **31**.

### N-7 — a citation to a file that has never existed

`publication-diff-parity.test.ts` cited `review-identity.test.ts`. The real file is
`publication-handoff.test.ts`. Corrected, and swept for other references. A citation to a
file nobody can open is worse than none, because it reads as though the coverage had been
checked.

N-2, N-4, N-5 and N-6 are orchestrator-owned and need no change here. For the record,
N-2's substance — M4-001 must invoke the solver from the caller's context after `run()`
returns, never from work scheduled inside the transaction — is consistent with the
boundary as shipped: the mark ends with the transaction, so work scheduled inside it and
executed after commit is permitted by design, and the runtime guard is what decides.

---

## 7. Standing facts

- **Synthetic data only.** No real patient, staff or customer name anywhere in this
  packet's code, fixtures, tests or captures.
- **No test sends a notification to a real person**; the probe provider's "external
  effect" is an in-process array, and it reaches nothing.
- **No compliance claim** of any kind is made or implied.
- **The source product was not visited.** No organization, site or person name from the
  research appears in any artifact here.

---

## 8. Second-merger integration — composed onto 000B

Rebased onto main `a614f7e` per doc 35 §2. **Ten commits, zero conflicts** — git
auto-merged `cloneVersion` because the two packets' edits are in disjoint regions (000B's
timezone-basis keys are in the `schedule_versions` insert; 000C's credit call appends at
the tail). The reviewer predicted a textual conflict there; it did not occur.

**Auto-merge is not proof of composition**, so the function body was verified directly:

```
const sourceBasis = await readTimezoneBasis(uow, sourceVersionId);      // 000B
  .values({ …, timezone_basis: sourceBasis?.zone ?? null,
                tzdb_version:  sourceBasis?.tzdb ?? null })             // 000B
  … shifts … snapshots …
await cloneCredits(uow, sourceVersionId, newVersionId);                 // 000C
await recordAuditEvent(…)
```

### The eight composition failures — five mechanisms

The first composed check found **eight** failures (not the six first reported). They are
what this battery exists to catch: neither packet's own battery could have found them.

**One root cause behind four.** `migration-0014-populated-cycle.test.ts` did
`migrate('down', { count: 1 })` and asserted `/0014/`, correct while 0014 was last. With
0015 above it, `count: 1` reverses **0015**, the assertion fails, **and it throws before
step 3 re-applies anything** — leaving the shared cluster with no 0015, so every later
`publication_records` writer died on `column "operation_type" does not exist`. That took
down `publication-concurrency` (×2) and `qualification-requirement-gate` (×2); nothing was
wrong with those four. Fixed with `count: 2` (a migration cannot be rolled back out from
under the one above it), asserting 0014 **by name rather than by position**, so the next
migration to land cannot repeat it.

**Two defects in 000C's tests, both caught by 000B's new invariants** — the invariants
working, not obstacles:

| Failure | Mechanism |
|---|---|
| matrix arm 2/9 | paired `second.assignmentIdentityId` with `first.snapshotId`; `credits_snapshot_carries_identity_fk` refused a credit pointing at a snapshot that does not carry its identity |
| clone-credits | minted a 2034 period then hard-coded 2035 dates; the shift↔period range invariant refused it. `freshPeriod` now RETURNS its range with a `dayIn()` accessor, so a caller cannot pick an outside date without saying so |

**The genuine two-packet interaction.** 000C's material-input digest includes the group
TIMEZONE, so the change that makes a draft's basis stale **also moves the digest** — and
the route-level CAS ran first, answering `STALE_REVIEW` where `TIMEZONE_BASIS_STALE`
belonged. True but useless: the scheduler re-reads, gets a fresh digest, confirms again,
and only then meets the cause. `assertTimezoneBasisFresh` now runs before the digest CAS.
**Neither control is weakened and 000B's 409 contract is untouched** — the service
re-asserts the basis inside the publishing transaction and remains the control; this is
the predict-the-refusal discipline every blocker on this surface already follows.

### The authorized addition — 000A's half-decorative retired-verdict arm

Repaired under FAD-30's standing rule. **Measured, not assumed** — with the source patched
and no rebuild:

| Test | Result | Why |
|---|---|---|
| `packages/domain/test/eligibility/verdict.test.ts` | 3 failed | imports source |
| `apps/api/test/profiles/verdict-convergence.test.ts` | **7 PASSED** | imports `dist`, never rebuilt |

So the arm reported PROVEN on the domain test alone while listing the convergence proof
beside it. Shrinking the claim would have been the weaker repair — the convergence proof
is the whole point of a SHARED verdict — so `prepare` now rebuilds `packages/domain`
between the patch and the red command, and `restore` rebuilds clean.

One thing neither offered option anticipated: **a plain rebuild fails to compile.**
Deleting the only read of `lifecycle` leaves it unused → `TS6133` → `prepare` fails → the
runner records **NOT PROVEN**, trading a half-decorative arm for a broken one. The
violation is therefore spelled compile-clean (`void lifecycle;`), preserving its meaning.
Verified standalone: GREEN 32/32; RED after rebuild — domain 3 failed AND convergence
1 failed, **both now observing**.

---
