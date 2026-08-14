# EV-M4-001S

## 0. Orchestrator acceptance battery (post-merge main `d910af6`, 2026-08-13, added at acceptance)

The squash merge's tree is byte-identical to the reviewed branch (empty diff), so this
battery serves as both the orchestrator's independent rerun and the clean-main
post-merge verification. Serial, every exit code from the inner `EXIT=` marker.

| Command | Result | Exit | File |
|---|---|---|---|
| validators (arch/fable/research) | 95/95 · 36/36 · PASS | 0/0/0 | (task record) |
| `corepack pnpm check` | 15/15 gates; unit 1801/1801 | 0 | `orchestrator-01-check.txt` |
| `corepack pnpm red-cases` — run 1 | **42/44** — `location-archived-guard` + `timezone-basis-stale-gate` GREEN arms failed with **"No test files found"** (vitest filter matched nothing for files that exist; both files pass standalone 6/6 and 8/8). A NEW transient infrastructure signature: the runner cannot distinguish it from a gate failure, and each such exit orphans the case's cluster daemon. Runner hardening assigned to M4-005 beside R-2 | 1 | `orchestrator-02-red-cases-FAILED-no-test-files-transient.txt` |
| run 2 | **43/44** — the two above PROVEN; `axe` GREEN arm failed (the documented Playwright/preview contention class; the axe gate passed in this same tree's `pnpm check`) | 1 | `orchestrator-02b-red-cases-FAILED-axe-transient.txt` |
| run 3 | **41/44** — three different cases (`unit`, `stale-edit-cas`, `draft-invisibility`). Diagnosis: 1-minute load average **96–123** from a wedged `mediaanalysisd` (322% CPU, 354 CPU-hours since Aug 5) plus a Spotlight indexing storm driven by the day's file churn. The daemon was killed (launchd restarts it); load fell to ~5 | 1 | `orchestrator-02c-red-cases-FAILED-load-storm.txt` |
| run 4 — **authoritative**, calm machine | **44/44 proven, 0 not proven** (incl. `requires-expiry-flip-serialization pass fail PROVEN`) | 0 | `orchestrator-02d-red-cases-authoritative.txt` |
| `corepack pnpm fixture-regression` | **129/129**, fresh rotating seed 368944 | 0 | `orchestrator-03-fixture-regression.txt` |
| `corepack pnpm sbx` | 6/6, 0 vacuous, 329 readings / 47 of 47 / 0 wrong-tenant | 0 | `orchestrator-04-sbx.txt` |
| `migrate:cycle:embedded` | **0001–0017 CYCLE CLEAN** | 0 | `orchestrator-05-migrate-cycle.txt` |

**Process defect recorded honestly (orchestrator's own):** the first fixture-regression
launch was CHAINED behind the red-cases result read, so it started before the red-cases
failure had been diagnosed — and the orchestrator's subsequent diagnostics and process
cleanup then ran against a machine with that battery active, invalidating it (its
transcript was discarded, and the stray processes killed during cleanup were its own
workers). The serial discipline exists precisely to prevent this; the closeout re-ran
everything cleanly and the lesson is recorded in the runbook's standing notes.

Independent review verdict: **ACCEPT, zero blocking** (probes retained on
`review/m4-001s` at `08c763a`). Observations V-1..V-4 recorded in the acceptance
ruling (FAD-37): V-1 the migration §1 "acquires NOTHING NEW" is true of locks, not of
the SELECT-only-role privilege surface (measured harmless — only INSERT-holding roles
reach the guard); V-2 a second advisory lock (`acquireStaffingSet`) is ordered against
the same rows, one-way today, 20 rounds clean — noted for M4-002; V-3 order (A) also
rests on the VOLATILE-function fresh-snapshot rule; V-4 0017 prevents creation, no
backfill CHECK — whole-database sweep found zero pre-existing violating rows. — write-time serialization of the `requires_expiry` flip

**Packet:** OPUS-M4-001S (doc 35 §6c), finalized 2026-08-13.
**Branch:** `opus/m4-001s-requires-expiry-serialization`, base commit `9b260eb`.
**Rulings consumed:** FAD-36(2) · FAD-28 R5 / FAD-28(2) · FAD-35 · FAD-33(1) ·
FAD-33(4) · FAD-15 · NR-17.

The M4-001R independent review reproduced a concurrency hole (finding R-1, probe
D3): a `requires_expiry` flip committing beside an in-flight open-ended grant
left `requires_expiry = true` with an open-ended live holding — the exact state
FAD-28 R5's sequential trigger refuses with 23001, and the one race with **no
read-side backstop**. This packet closes it at the database, proves both orders,
proves the falsification, and corrects the one comment that overclaimed.

---

## 1. What shipped

| Clause (§6c Required behaviour) | Change |
|---|---|
| **(1)** both orders refused at write time | `apps/api/migrations/0017_requires_expiry_flip_serialization.sql` (new). `CREATE OR REPLACE` of the two 0012 guard bodies, per the 0011 precedent: the holding guard reads the qualification `FOR KEY SHARE`; the flip guard takes `FOR UPDATE` before its `EXISTS` over the holdings, and only on the `false → true` transition. No table, no policy, no grant, no index, no RLS change |
| **(1)** lock-ordering analysis vs the 0003 audit advisory lock | Migration §3 (the argument) and case (D) of the proof (the measurement). §4 below |
| **(2)** the permanent concurrent proof | `apps/api/test/profiles/requires-expiry-flip-serialization.test.ts` (new) — four cases: both gated orders, the ungated crossed rounds, and the lock-order inversion. Every case asserts the FINAL-STATE INVARIANT from ground truth |
| **(2)** the sequential R5 arms untouched | `staffing-integrity-red-cases.test.ts` is not edited and passes throughout (§3, §5) |
| **(3)** the red/mutation case | `scripts/red-cases/run.mjs` case `requires-expiry-flip-serialization` — the two locking clauses patched back to the 0012 bodies. Verified both directions standalone (§3) |
| **(3, extra)** migration cycle over a populated database | `apps/api/test/profiles/migration-0017-populated-cycle.test.ts` (new) — up → down → up **by name**, and the D3 admission is measured at the midpoint, where 0017 is reversed |
| **(4)** the solver-snapshot overclaim | `packages/domain/src/ports/solver-snapshot.ts` — the `validUntil` comment now states the actual contract (0012 sequential, 0017 concurrent) and records that the earlier wording was falsified. Comment only |
| **(5)** R-3: `waitUntilBlockedOnLock` | Extracted to `apps/api/test/profiles/lock-observation.ts` and tightened: the caller names the expected `wait_event` and the expected blocking backend, matched against `pg_blocking_pids()`. `granted-while-retiring-inertness.test.ts` now asserts `Lock/advisory` **held by the retirement's pid** |

### Files changed (the complete diff surface)

```
 A apps/api/migrations/0017_requires_expiry_flip_serialization.sql
 A apps/api/test/profiles/requires-expiry-flip-serialization.test.ts
 A apps/api/test/profiles/migration-0017-populated-cycle.test.ts
 A apps/api/test/profiles/lock-observation.ts
 M apps/api/test/profiles/granted-while-retiring-inertness.test.ts   R-3 only
 M packages/domain/src/ports/solver-snapshot.ts                      comment only
 M scripts/red-cases/run.mjs                                         one ADDED case
 A docs/evidence/EV-M4-001S/**
```

All inside the packet's Allowed files. Nothing else was touched — expressly not
`packages/domain/src/eligibility/**` (frozen), not migrations 0001–0016, not
`solver/**`, not `apps/web/**`, not `docs/{architecture,fable}/**`, no gate, no
existing red-case arm, no service source. **`apps/api/src/profiles/qualifications.ts`
was NOT edited**: §2c says why the service-layer complement the packet permits is
not needed.

---

## 2. The mechanism, stated precisely

### 2a. Why the old code admitted the race

Both writers checked, and neither could see the other. The flip's `EXISTS` ran
under a snapshot predating the holding's commit; the holding guard's lookup ran
under a snapshot predating the flip's commit. Nothing conflicted, because a
retirement-style `UPDATE` of a non-key column takes `FOR NO KEY UPDATE`, which is
compatible with the `FOR KEY SHARE` a holding's foreign key takes.

### 2b. What 0017 changes

One lock object — the `qualifications` row both writers already touch — in two
modes that CONFLICT:

| side | mode | when |
|---|---|---|
| `app_guard_holding_expiry_retirement` | `FOR KEY SHARE` | in the same lookup that reads `requires_expiry` |
| `app_guard_requires_expiry_flip` | `FOR UPDATE` | before the `EXISTS`, only on `false → true` |

* **grant first** — the flip blocks at its `FOR UPDATE`; when the grant commits,
  the flip's next statement takes a new READ COMMITTED snapshot, sees the
  committed open-ended holding, and raises `QUALIFICATION_REQUIRES_EXPIRY_CONFLICT`.
* **flip first** — the grant blocks INSIDE the guard, before it has read
  `requires_expiry`; when the flip commits, the locking read re-evaluates against
  the latest row version and the existing `QUALIFICATION_REQUIRES_EXPIRY` arm
  raises 23001.

The lock is taken **in** the lookup rather than beside it, and that is
load-bearing: a separate `PERFORM … FOR KEY SHARE` followed by the old unlocked
`SELECT` would hold the lock and still read the stale value.

### 2c. Why no service-layer complement was needed

The packet permits one "ONLY if needed, justified per edit". It is not needed:

* the trigger is the boundary that binds every writer, and there is **no service
  path that flips `requires_expiry` at all** (0012 §3b) — the service half of R5
  does not exist to be strengthened;
* the refused grant already surfaces correctly. `apps/api/src/http/routes/profiles.route.ts`
  maps SQLSTATE `23001` to **422**, which is the same answer the service's own
  `QUALIFICATION_REQUIRES_EXPIRY` produces on the sequential path. Adding a
  locking read to `grantHolding`'s pre-check would duplicate the guard's lock for
  a response code the caller already gets.

Not editing it also keeps the diff surface at one migration plus tests.

### 2d. The granted-while-retiring race is NOT closed — deliberately

FAD-28(2)/FAD-35 make that interleaving authoritative, and
`granted-while-retiring-inertness.test.ts` pins it. It survives 0017 because a
retirement holds `FOR NO KEY UPDATE`, which does not conflict with the grant's new
`FOR KEY SHARE`: the grant does not wait, does not re-evaluate, and reads `active`
exactly as before. Measured — the race still establishes on `Lock/advisory` and all
four arms pass (§3, §5).

---

## 3. The proof, and what it measured

`apps/api/test/profiles/requires-expiry-flip-serialization.test.ts`, run
standalone. Every block is OBSERVED in `pg_stat_activity` with the blocking
backend named by `pg_blocking_pids()` — no sleep decides anything.

| Case | Measured |
|---|---|
| **(A)** grant first | `A: flip backend 53596 blocked on Lock/transactionid held by grant backend 53595, then refused 23001` — final state `requires_expiry=false`, 1 open-ended live holding |
| **(B)** flip first | `B: grant backend 53595 blocked on Lock/transactionid held by flip backend 53596, then refused 23001` — final state `requires_expiry=true`, 0 open-ended live holdings |
| **(C)** crossed, ungated | `C: 6 crossed rounds in 18ms — grant-first:grant flip-first:flip …` — exactly one writer wins each round, no 40P01, invariant after every round |
| **(D)** lock-order inversion | `D1 (0012 objects only, no 0017): inverter=40P01 holder=NO ERROR` · `D2 (0017 edge, inverted order): flipper=NO ERROR granter=40P01` — §4 |

The invariant — never `requires_expiry = true` together with an open-ended live
holding — is re-read from ground truth with the superuser after every case, so a
case that stopped refusing for some new reason still fails.

### 3a. Falsifiability — both directions, verified standalone

The red case patches migration 0017's two locking clauses back to the 0012
bodies. The api project's global setup runs the migration cycle against a
freshly-initialised cluster on every `vitest run`, so the patched guards are the
ones the tests meet — no rebuild is involved (the `work-profile-delete-capability`
precedent).

| Arm | Command | Result | Exit | Transcript |
|---|---|---|---|---|
| **GREEN** (clean tree) | `vitest run …/requires-expiry-flip-serialization.test.ts …/migration-0017-populated-cycle.test.ts` | 2 files, **5 tests passed** | `0` | `03-red-arm-green.txt` |
| **RED** (both locks removed) | same command, after the patch | **2 files failed, 5 failed** | `1` | `04-red-arm-red.txt` |

Every one of the five bites, and each bites in the predicted way:

```
FAIL (A) … Error: backend 54587 was not blocked on Lock/transactionid|tuple held by
           backend 54586 within 20000ms (last seen: state=idle wait=Client/ClientRead …)
FAIL (B) … the same, with the roles reversed
FAIL (C) … AssertionError: round 0: 2 writers committed: expected 2 to be 1
FAIL (D) … AssertionError: D2: the inverted order did not produce the bounded refusal
FAIL migration-0017-populated-cycle … the re-applied 0017 did not BLOCK the flip
```

`(C)`'s "2 writers committed" **is** the defect: with the locks gone both the flip
and the open-ended grant commit, which is precisely the forbidden final state.

A note on why the red arm takes 43s: with the serialization removed, (A) and (B)
wait out their 20-second observation budget before failing. Both gated arms
release their gates in a `finally` — without that a violation would HANG the run
instead of failing it, which is how the first red-arm attempt was found and fixed.

### 3b. The populated migration cycle — the same falsification, from the migration side

`migration-0017-populated-cycle.test.ts` rolls down **by name** (FAD-33(4): the
loop's termination condition is the name, the whole cycle sits inside the `try`,
the re-up is unconditional in the `finally`) and measures the interleaving at the
midpoint:

```
midway (0017 down): flip=NO ERROR → requires_expiry=true with 1 open-ended live
                    holding — the D3 admission
after re-up:        concurrent flip refused 23001, sequential flip refused 23001
```

The midway state is undone inside the same case (`true → false` is not a flip and
no guard forbids it), so the fixture leaves nothing violating behind. The two
census tables are byte-identical across the cycle — 0017 creates and drops
nothing.

---

## 4. The lock-ordering analysis (doc 35 §6c: MANDATORY)

**The rule, and it is not changed by this migration:**

> the `qualifications` ROW lock is acquired BEFORE the per-organization AUDIT
> ADVISORY lock, in every shipped writer.

It holds by construction, because every staffing service writes its audit row
LAST: `grantHolding` inserts the holding (guard + FK → `KEY SHARE`) then calls
`recordAuditEvent`; `changeHoldingStatus` the same; `setQualificationStatus`
updates the row then records. The flip has no service path at all.

**Why 0017 cannot introduce a cycle.** Both acquisitions it adds land INSIDE the
statement that already locked that same row — the holding side moves the FK's
`KEY SHARE` earlier within one INSERT, the flip side upgrades the UPDATE's own
`FOR NO KEY UPDATE` within one UPDATE. No other lock is acquired between the old
and the new acquisition point, so the ORDER of every lock in every shipped
transaction is unchanged; only the mode on the qualification row is stronger. A
cycle needs an inversion, and there is none to invert. Case (C) is that rule in
operation: six ungated crossed rounds, both launch orders, 18ms, no 40P01.

**The residual, measured rather than asserted.** A transaction that took the
audit lock FIRST and then wrote a qualification row would invert the order. Case
(D) constructs exactly that, twice:

* **D1** uses only 0012 objects — a transaction that has already written an audit
  row, then updates a qualification another transaction holds. It deadlocks
  (`inverter=40P01`). **The hazard is a property of the audit advisory lock and
  it predates this migration**; nothing from 0017 participates.
* **D2** routes the same inversion through 0017's new edge (an audit-holding
  transaction flipping while a grant holds `KEY SHARE`). Identical behaviour:
  `granter=40P01`, bounded by `deadlock_timeout`, one transaction aborted and the
  other's work the only work that committed.

In both halves the invariant survives, because **a deadlock is a refusal** — the
detector aborts one side and nothing violating can commit. The case also asserts
that no backend is left `idle in transaction` afterwards and that an ordinary
flip still works.

So the escalation condition in §6c ("deadlock risk cannot be excluded by ordering
argument + test") is **not** met: the risk is excluded for every shipped path by
an ordering argument that a test exercises, and the one construction that breaks
the rule is pre-existing, unreachable from the service layer, bounded by the
database, and non-violating. It is recorded here rather than hidden.

---

## 5. Commands run — actual results

Serial, in the worktree, each transcript ending in its own `EXIT=` line taken
from `$?` inside the redirected block (never after a pipe — the R-4 slip).

| # | Command | Result | Exit | Transcript |
|---|---|---|---|---|
| 1 | `corepack pnpm install` | up to date, 467 packages | `0` | `01-install.txt` |
| 2 | named proofs standalone (4 files incl. the untouched R5 arms) | **27 tests passed** | `0` | `02-named-proofs-standalone.txt` |
| 3a | the new red case's GREEN arm | 2 files, 5 passed | `0` | `03-red-arm-green.txt` |
| 3b | the new red case's RED arm | 2 files failed, 5 failed | `1` | `04-red-arm-red.txt` |
| 4 | `corepack pnpm check` | **15/15 gates PASS**; unit 142 files / **1801 tests** | `0` | `05-check.txt` |
| 5 | `corepack pnpm red-cases` | **44 case(s): 44 proven, 0 not proven** | `0` | `06-red-cases.txt` |
| 6 | `corepack pnpm fixture-regression` | **129 run(s): 129 passed, 0 failed**, fresh rotating seed 518351 | `0` | `07-fixture-regression.txt` |
| 7 | `corepack pnpm sbx` | 6 scenarios, 0 vacuous; **329 readings / 47 of 47 tables / 0 wrong-tenant** — floor unchanged | `0` | `08-sbx.txt` |
| 8 | `migrate:cycle:embedded` | **0001–0017 by name, CYCLE CLEAN** | `0` | `09-migrate-cycle.txt` |

### 5a. The battery in the transcripts' own words

**`pnpm check` — 15/15.** `lint · typecheck · unit · import-boundary · route-policy ·
migration-rls · invariant-ids · rule-node-mapping · rule-kind-registry ·
provider-boundary · secret-scan · build · network-guard · axe · request-budget`, all
`PASS`. Unit: `Test Files 142 passed (142) / Tests 1801 passed (1801)` — 140/1796
before this packet, plus this packet's two files and five tests.

**`pnpm red-cases` — 44/44 PROVEN**, the count rising by one because this packet
added a CASE rather than extending one:

```
retired-verdict                     pass   fail   PROVEN
requires-expiry-flip-serialization  pass   fail   PROVEN
44 case(s): 44 proven, 0 not proven
```

**`pnpm fixture-regression` — 129/129**, fresh rotating seed:

```
2. ROTATING SEED — this run drew 518351
PASS  rotating seed 518351    54.3s  1214 passed (1214)
...
PASS  profiles/migration-0017-populated-cycle.test.ts        2.6s  1 passed (1)
PASS  profiles/requires-expiry-flip-serialization.test.ts    4.7s  4 passed (4)
129 run(s): 129 passed, 0 failed
Order-independent under every seed tried. Every file also passes alone.
The shared baseline was unmodified in every run (the Layer 1 control runs in each).
```

Both new files ran under all fourteen fixed seeds, the rotating seed, and alone —
with file AND test order shuffled. That matters more than usual here: the
populated-cycle file rolls migrations down and back up mid-run, and the Layer-1
baseline-immutability control passed in every one of those runs.

**`pnpm sbx` — floor unchanged.** `329 readings … 0 wrong-tenant rows; 47 of 47
tables observed with visible rows` — byte-identical to the EV-M4-BOUNDARY §2b
floor. No table was added, so unchanged is the correct outcome rather than a
missed raise.

**Migration cycle 0001–0017.** All seventeen applied BY NAME, reversed in full,
re-applied identically: `MIGRATION CYCLE CLEAN — up -> down -> up -> down -> up,
1134ms`, `cluster: stopped`.

**Contention:** none observed in the accepted runs. No test FILE failed with tests
skipped, and the R-B4a enumeration did not time out. One earlier `red-cases`
attempt and one earlier red-arm attempt were killed by a 10-minute harness cap and
by the gate leak described in §3a respectively; both were re-run to completion and
the transcripts above are those complete runs. Nothing was re-run in order to make
it pass.

---

## 6. Honest notes and limitations

- **The proof depends on PostgreSQL's row-lock conflict matrix**, and says so:
  `FOR UPDATE` conflicts with `FOR KEY SHARE`, `FOR NO KEY UPDATE` does not. Both
  halves are exercised — the first by (A)/(B), the second by the retirement race
  continuing to establish unchanged.
- **`(C)` measures the crossing, not a distribution.** Six rounds is enough to
  show both launch orders settle bounded with exactly one winner; it is not a
  stress test and does not claim to be.
- **`(D)` demonstrates a deadlock on purpose.** It is a construction the service
  layer cannot produce today. If a future writer ever takes the audit lock before
  writing a qualification row, this case is the record of what that costs.
- **The flip has no service path**, so every arm here drives it as raw SQL inside
  a unit of work, as the reviewer's probe did. That is not a shortcut around the
  service: it is the only writer that exists, and it is the reason the rule lives
  in a trigger.
- **`pg_stat_activity` and the ground-truth reads use the superuser client**,
  which is harness observation only. No assertion about application behaviour is
  satisfied by a superuser read; the invariant reads are deliberately reads
  *about the database*.
- **Nothing was weakened.** `waitUntilBlockedOnLock` gained two required
  conditions and lost none; no assertion was removed anywhere; the sequential R5
  arms in `staffing-integrity-red-cases.test.ts` are untouched and pass.
