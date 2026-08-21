# EV-M4-005 — integration, concurrency/recovery, hardening, and the milestone-close inputs

**Packet:** OPUS-M4-005, doc 35 §6g + **FAD-48**. **Branch:** `opus/m4-005-integration`,
rebased onto `64a6ad2`. **Status: ALL SIX CLAUSES BUILT. (A) is BUILT and RUNNING against
the real stack (§17). NR-15 diagnosed and repaired; its verification state is §14b/§18.**

**FAD-48 ruled the (A) escalation: the browser↔server join is BUILT, not waived** — a
mocked critical path is REFUSED. **It is now built and it runs.** `GET /me/context`
returns the freshness counters no response had ever carried; `apps/web/src/api/context.ts`
declares them on every capability request; and `apps/web/e2e/critical-path.spec.ts` drives
the workflow at both viewports against a real browser, a real API, real PostgreSQL, a real
worker and real CP-SAT, **with `page.route` nowhere in the file**. §17 is the record. §12
is retained UNCHANGED as the measurement that made the ruling possible — its *status* is
superseded, its *measurement* is not.

This bundle records what was built and proven, and — with equal prominence — what was
**not**:

* **two of the fourteen critical-path steps have no browser surface in M4** and are driven
  over real HTTP instead. Disclosed in §17e, never faked;
* **NR-15 REPRODUCED** earlier in this packet. doc 35 §6g ruling (3) says that if it does,
  "the packet pauses on it and the capture is now the diagnosis". It did, the widened
  capture caught it, §14b is the diagnosis, and **§18 diagnoses the residual completely —
  a drain and the assertion that it worked were using different predicates — repairs it at
  the shared seam, and states plainly that the repair is NOT yet verified by a re-run.**

**§19 is the current-state summary Fable lifts into doc 36**: what M4 proved, what it did
not, and the CI conditions that remain open. **Nothing here is a production-readiness claim
and nothing here is a compliance claim of any kind.**

**Nothing here is a production-readiness claim, and nothing here is a compliance claim
of any kind.**

---

## 0. What was delivered, against doc 35 §6g's Included list

| Clause | State | Where |
| --- | --- | --- |
| **(A) Critical-path e2e** — the 14-step workflow against the real stack | **BUILT AND RUNNING.** The endpoint, the client sender and the real-stack suite; both viewports, axe green, every interaction recorded. Two steps have no browser surface in M4 and are driven over real HTTP, disclosed | **§17**, §12 (the obstacle, as measured) |
| **(B) The concurrency-and-recovery matrix** | **DONE** — 40 named proofs, every row | §3 |
| **(C) SBX-015/016/017** | **DONE** — 3 scenarios, 9/9 PASS, 22/22 detection, 0 vacuous | §11 |
| **(D) D-4b + the queue binding** | **DONE** — migration 0019, `build.solve`, S-16t | §2 |
| **(E) The hardening register** | **DONE** — including the scoped screenshot regeneration | §4, §13 |
| **(F) Regression + current-state documentation** | **DONE with one FAILING gate reported, not smoothed** — full battery in §14 | §5, §6, §14 |

Nine commits, each its own boundary:

| Commit | Subject |
| --- | --- |
| `cb39016` | D-4b + the queue binding, and the absolute staleness rule |
| `8eae17a` | the concurrency-and-recovery matrix, and the defect it found |
| `dc4aa1d` | the hardening register — NR-15/16/18/19, R-2, R-10, the phantoms |
| `5a0bcb7` | migration 0019's cycle, the import cycle it exposed, and the docs |
| `e0da8c1` | the batteries that ran, and an honest record of the one that did not |
| `36c2de7` | INDEX commit table completed |
| `553f192` | SBX-015/016/017 — execution, 22 injected hard violations, progressive builds |
| `cac05f9` | the EV-M4-004 cross-snapshot capture, regenerated — those two files and no others |
| `35d150d` | the five orphaned `build.solve` jobs, and the three files they broke |

---

## 1. The three defects this packet found — two in accepted code, one its own

The first two were found by the matrix and neither is cosmetic. The third is mine, and
it is here at the same prominence for the reason the others are: a bundle that leads
with what it built and buries what it broke is reporting badly.

### 1a. The queued path could not claim a build at all

Moving dispatch onto the queue (D-4b) means `claimQueuedBuild` runs in a unit of work
opened by the **worker**, whose context legitimately names no acting membership.
`recordBuildEvent` then reached `recordAuditEvent`, which threw:

```
AUDIT_ACTOR_UNRESOLVED: the unit of work names no acting membership and the draft
did not declare itself a system action. Refusing to attribute the event to nobody.
```

The recorder was right. The caller was wrong: **a worker claiming a build is a system
act**, and `recordBuildEvent`'s own docblock already said so — "the reaper and the claim
are system acts and say so" — while the claim never said it. Under the API-process
dispatch this was invisible, because the claim inherited whichever scheduler had pressed
the button, and the audit chain recorded a human as the actor for a machine's decision.

Repaired in `builds/service.ts`: the resolved actor is computed **once** and the
system-actor marker is derived from it, so the timeline row and the chain entry can no
longer disagree about who acted. Caught by three arms independently (M-02b, M-03, and
the registered-task arm), each of which would otherwise have shipped as "every queued
build fails at claim time".

### 1b. A fifth raw NUL, mine, caught by the gate one hour after it was hardened

`builds/staleness.ts`'s `keyOf` used a raw `U+0000` as its separator. The gate mandated
by FAD-45(1) after the *third* recurrence found it immediately. It is now the escape
`\x00`, which produces an identical string and is visible to a reader and to grep.

Recorded rather than quietly fixed, because the honest reading is that the class recurs
against every written lesson and the automated control is what actually stops it. That
is the argument FAD-45(1) made; this is the first independent confirmation of it.

### 1c. A third defect — this one MINE, and the shared-resource gap it exposed

The first `pnpm check` after SBX-015/017 landed FAILED. Sixteen of seventeen
gates, `unit` red, three files broken and not one of the messages mentioning a
build:

```
outbox-dispatch.test.ts   the queue still holds 5 job(s) after 45000 ms
crash-restart.test.ts     the queue still holds 5 job(s) ... block B cannot
                          establish its precondition
periodic.test.ts          periodic-r10-drain: the queue still holds 5 job(s)
```

**Five.** SBX-015 submits three builds and SBX-017 submits two.

D-4b (§2b) made `submitBuild` enqueue a `build.solve` job in the same transaction
as the `queued` transition. Both scenarios then dispatch DIRECTLY through
`runQueuedBuild` — which is what every proof about the claim, the fence and the
outcome does — so each build settles and its job stays in the queue. The job is
not a defect: on delivery it answers `not-claimable`, the duplicate-delivery
behaviour M-02b proves. It is simply un-consumed.

`drainQueue` cannot consume it. It starts an OUTBOX runner, which registers the
outbox and `audit.*` tasks and nothing else, and then waits for `queuedJobCount`
— a count over ALL jobs — to reach zero. A `build.solve` job it has no handler for
makes that loop unsatisfiable.

That is FAD-15 Layer 3 exactly, and `test/support/queue.ts`'s own header already
said the words: "the graphile-worker queue is not a tenant table … any worker
takes whatever job is next … a file that starts a worker must **establish and
assert** its precondition rather than assume it." What the module did not have was
a drain for the second kind of job. **The matrix had been getting away with the
same thing** — its registered-task arm starts a real pool which happens to clear
the backlog — which is an ordering accident, the thing FAD-15 exists to stop
relying on.

The repair is at the shared resource, where R-10's own note argued it belongs:
`drainBuildSolveQueue` empties the backlog through the PRODUCTION consumer and
**asserts its precondition first** — every job in the backlog must name a build
that is already SETTLED. Under that precondition the runner can only answer
`not-claimable` and complete the job; it cannot start a solve, spawn a subprocess
or move any state. It may not dispatch a stranger's build either: a teardown that
quietly solved somebody's queued build would be a teardown that made the schedule,
so a backlog naming an in-flight build is left alone rather than drained.

**That repair was necessary and not sufficient**, and the fixture-regression gate is
what said so — see §14b. Five orphaned jobs were mine; two more came from another
producer under a shuffled order, and the general defect was one level down: `drainQueue`
was waiting for a job it had no handler for, which is a deadlock by construction. The
second repair is in §14b.

Both scenarios now record what they released — SBX-015 three jobs, SBX-017 two —
and one comment in the matrix is corrected rather than left standing: "this file
is the only producer of `build.solve` jobs in the suite" stopped being true the
moment SBX-015 landed, and it had been asserting an isolation property the arm
does not rest on.

Recorded here at the same prominence as §1a and §1b because a bundle that reports
the defects it found in other people's code and not the one it created is
reporting selectively.

---

## 2. (D) D-4b and the queue binding

### 2a. Migration 0019 — and why a migration at all

doc 35 §6g allocates `0019_*` "ONLY IF D-4b's per-organization concurrency cap genuinely
needs a schema surface". It does, and the need is precise:

`build_runs` is **group-scoped** under RLS (0018 `build_runs_group_scope`). A unit of
work opened for one group sees that group's in-flight builds and no others, so a cap
computed from that read is a **per-group** cap wearing the wrong name — an organization
with five groups would run five times the limit with every test still green.

The cap **value** needs no schema: SPEC-04 §1.1 lists it under *Resource isolation*, in
the same row as "CPU and memory limits per solve". Those are facts about the machines,
not about a tenant. So 0019 creates **no table** — one policy and one function:

| Object | Shape |
| --- | --- |
| `build_runs_organization_capacity_read` | `FOR SELECT TO app_migrator`, pinned to `current_setting('app.organization_id')` |
| `app_build_running_count(uuid)` | `SECURITY DEFINER`, returns an **integer**, refuses any organization but the caller's own |

**This is not a second cross-tenant read.** It admits the caller's own organization and
crosses a GROUP boundary only. The reach is a policy rather than a bypass for the reason
migration 0003 gives: `FORCE ROW LEVEL SECURITY` binds the table owner, so `SECURITY
DEFINER` alone reaches nothing, and the reach has to be written down.

The context guard is mandatory and 0003's R-05 says why: **with the policy alone, a
foreign organization id matches no row and the count returns `0`** — which is not an
error, it is a confident statement that the tenant has nothing running, and it would
silently disable the cap. Proven both ways in the matrix.

Registered as the **second** sanctioned role-scoped policy in
`apps/api/test/tenancy/roles-and-schema.test.ts`, with its reasons and two sibling pins.

**No new tenant table**, so the SBX-004 sweep floor is **unchanged** (48 registry / 47
sweep as M4-001 left it, then 54/53 after M4-003's six tables — this packet adds none).

### 2b. The binding

`submitBuild` enqueues `build.solve` **in the same transaction** that moves the run to
`queued`. SP-D E-1.1 is what makes that correct — `SECURITY DEFINER` opens no
transaction of its own — and the matrix proves both halves: the job exists after a
commit, and a rolled-back submission enqueues nothing.

The consumer is its own graphile-worker pool (`builds/queue-runner.ts`), not another
task on the outbox runner's. An outbox dispatch is milliseconds and a solve is minutes;
one shared concurrency budget means a saturated solver stops every notification in the
system.

**Saturation throws**, so graphile-worker's own exponential backoff schedules the retry.
The cost is stated rather than hidden: attempts are bounded, so an organization that
stays at its cap for the whole retry envelope ends with a permanently-failed job and a
build still sitting in `queued`. `requeueOrphanedQueuedBuilds` is the recovery for
exactly that, wired into the reap route and proven by M-06b.

**S-16t** (§3, row S-16t): alpha at its cap is `deferred` — **state unchanged, epoch
unchanged, no event written**, because a deferral that spent an epoch would fence a
worker that had done nothing wrong — while beta claims in the same window with
`runningCount: 0`. A cap counted globally, or one whose read crossed the tenant
boundary, would starve beta here.

### 2c. Staleness — doc 35 §6g ruling 4, which did not exist before

> A build whose **ANY** input revision changed after snapshot assembly is visibly STALE
> and can **NEVER** silently become the current draft.

Selection carried FAD-26(2)'s compare-and-set, which covers the **source draft** and
nothing else. It says nothing about a revised rule, an archived shift type, an expired
qualification, re-set demand, a changed timezone. A candidate applied over any of those
is a schedule computed from a world that no longer exists, and no screen said so.

`builds/staleness.ts` re-runs the assembly and compares against the 0016 constituents.
The comparison uses the **same** `assembleCanonicalInput` that produced the pinned list,
so there is one definition of what a build depends on and a constituent kind added later
is covered on the day it is added. All three directions count, including `added` — demand
for a date the candidate never saw.

Selection refuses with the typed `STALE_BUILD_INPUTS` carrying the itemised changes; the
detail response carries the staleness so the screen says so **before** the scheduler
decides, and the Select control is disabled (not hidden) with the banner giving the
reason.

### 2d. F-12, discharged

`solverStatus` now renders on the build **list** and the **comparison**, as the solver's
own raw token and never a gloss. A merely-`FEASIBLE` candidate and a proven-`OPTIMAL`
one were indistinguishable exactly where the distinction decides something. The raw
token is deliberate: a state label carrying the word "optimal" would say it about every
result reaching that branch, which is what `builds-optimality-wording`'s red case exists
to prevent — and that arm is unaffected.

---

## 3. (B) The concurrency-and-recovery matrix

`apps/api/test/builds/concurrency-recovery-matrix.test.ts` — **40 named proofs, 40
passed**, every outcome asserted in the database, every race a real race on independent
pooled connections asserted on the OUTCOME SET rather than on which side won.

| Row | Proof (test title) | Outcome asserted |
| --- | --- | --- |
| **M-01** simultaneous submission | two schedulers submitting ONE build produce exactly one queued run and one job | 1 fulfilled / 1 `BuildStateMovedError`; state `queued`; **exactly one** `build.solve` job — the loser must not also enqueue |
| **M-02** idempotent retry | twelve concurrent creations with ONE key produce exactly one row (D-17) | one `build_run_id`; one row in the database |
| **M-02b** duplicate delivery | a re-delivered build.solve job for a settled run answers not-claimable | `not-claimable`; exactly **one** `build_run_results` row |
| **M-03** duplicate worker result | a duplicate result at the CURRENT epoch is refused by the database, service bypassed | raw `INSERT` as the owner rejected by `app_guard_build_result_fencing`; still one result |
| **M-04** stale worker result | a result at a SUPERSEDED epoch is refused AND recorded, on the queued path | `BuildResultFencedError`; `result_refused:stale_claim_epoch` **row survives the rollback**; run `failed`/`crashed` |
| **M-05** worker crash | a dead heartbeat settles the build as failed/crashed | `failed` + `crashed`; `claimed_by` null; epoch +1; `heartbeat_reaped:heartbeat_expired`. Never `deadline`, never `killed` |
| **M-06** API/worker restart | a pool that dies holding a lease is reclaimed by its successor (SP-D C-2) | the dead pool id reclaimed; `released_at` set |
| **M-06b** orphaned queued build | a QUEUED build whose job is gone is re-delivered rather than failed | job count 1 → 0 → 1; run still `queued`, `termination_reason` null |
| **M-07** cancellation during solve | a cancel during a RUNNING solve is requested, not asserted — and lands as CANCELLED | real dwelling subprocess; `immediate: false`, state stays `running`; settles `cancelled`/`user_cancelled`/`CANCELLED`; `cancel_requested` recorded |
| **M-08** timeout during solve | a solve that outruns its wall clock is TERMINATED and says so | `failed` + **`killed`** (mechanism 3). `deadline` would be the parent claiming the solver did something it did not — mechanism 1 has its own proof in `worker-lifecycle.test.ts` |
| **M-09** result after cancellation | a result arriving AFTER a cancellation is refused and recorded | `BuildResultFencedError`; **zero** candidate rows written afterwards |
| **M-10** rules | one arm per input class (below) | `stale`, change names kind `rule`; `BuildInputsMovedError`; run still `approved`, `applied_to_version_id` null |
| **M-11** catalogue | shift type | same, kind `shiftType` |
| **M-12** locations | location | same, kind `location` |
| **M-13** qualifications | qualification | same, kind `qualification` |
| **M-14** qualification holdings | profiles | same, kind `qualificationHolding` — spelled differently because 0004's guard refuses `valid -> valid`, so the move is a real lifecycle step |
| **M-15** demand | period requirements, through the production editor | same, kind `requirement` |
| **M-16** timezone | basis change | same, kind `timezoneBasis` |
| **M-17** participants | staff-group membership | same, kind `staffGroup` |
| **M-10 CONTROL** | MUTATION CONTROL: with NOTHING changed, the identical flow reaches a new draft | `applied_to_draft_schedule` + a draft id. Without this the eight above prove only that *something* refuses |
| **M-18** participant inactivation | an inactivated participant makes the inputs UNASSEMBLABLE, and selection refuses | `stale` with assembly refusals; `BuildInputsMovedError` |
| **M-19** double selection | two concurrent selections of ONE build produce one draft and one refusal | 1 fulfilled / 1 rejected; D-4d holds in the database |
| **M-20a** two builds, same config | D-4a refuses a second in-flight build of the SAME configuration | the partial unique index refuses |
| **M-20b** two builds, different configs | D-4b admits two DIFFERENT configurations of one period concurrently | 2 rows `queued` for one period — a per-PERIOD cap would refuse this and nothing else would notice |
| **M-21** stale expected version | a selection quoting a stale source digest is refused, and nothing is written | `BuildSourceMovedError`; still `approved`, nothing applied |
| **M-21b** the CAS is about a real edit | and the refusal is about the DRAFT moving, not merely a wrong string | an assignment added after the build moves the digest; the arm throws if it did not, so it cannot pass vacuously |
| **M-23** invalid worker output | a hostile worker response is REJECTED and settles failed/rejected | `failed`, never `completed`, never `infeasible`; `usable = false` |
| **M-24** infeasible-explanation timeout | a degraded explanation leaves the build INFEASIBLE | state `infeasible` (never `failed`); `explanation_state = EXPLANATION_BUDGET_EXCEEDED`. An explanation failure is not a scheduling verdict |
| **M-25** progressive pin conflict | a protected identity that names no assignment on the source is REFUSED, not ignored | submission bounces to `draft_configuration` with **itemised** findings |
| **staleness unit** | sees all THREE directions, including the added one a naive check misses | 3 changes: `added`, `removed`, `moved` |
| **staleness CONTROL** | identical lists produce no change at all | 0 |
| **D-4b** context guard | the counter REFUSES an organization that is not the caller's own | `BUILD_CAPACITY_CONTEXT_MISMATCH` |
| **D-4b** policy reach | the capacity POLICY is reachable by NO application role directly | `app_runtime` and `app_worker` both see 0 foreign-group rows |
| **D-4b** lock derivation | the advisory-lock derivation agrees with the staffing one on a fixed vector | identical bigint |
| **D-4b** configuration | the configured cap refuses a value that is not a positive integer | default 2; `'4'` → 4; `'four'` and `'0'` throw |
| **S-16t** | alpha at cap defers; beta solves in the same window | alpha `deferred` with state/epoch/events untouched, task body throws `BuildCapacitySaturatedError`; beta admitted with `runningCount: 0` and claims |
| **queue** atomicity | the enqueue is in the SAME transaction as the transition (SP-D E-1.1) | 0 → 1 job; payload parses; keys are **exactly** the four identifiers (I-07) |
| **queue** rollback | a rolled-back submission enqueues NOTHING | 0 jobs |
| **queue** payload | a malformed payload is refused rather than guessed at | four shapes refused, one accepted |
| **queue** registration | the REGISTERED task runs a submitted build to a terminal state | a real pool claims and settles it — a body that is written and never registered is the defect `outbox/runner.ts` records |

**No row was unconstructible**, so no row was escalated.

**How the staleness arms move a revision, stated plainly.** Through **granted columns**
under a **capability-holding context** — never by writing `version` (no application role
holds that grant, which is exactly what makes citing a revision meaningful) and never
with a trigger suspended. `app_maintain_catalogue_version` is unconditional by design —
"a no-op UPDATE still bumps, because a writer that read version N and wrote nothing still
has to lose to a writer that read N and wrote something" — so an ordinary granted write
is how a revision moves in production. `bumpConstituent` throws on a zero-row update, so
an arm cannot assert staleness against a world that did not change.

**One fixture disclosure.** Within this file's owned tenant the scheduler is granted four
capabilities it does not hold elsewhere (`schedule.catalogue.administer`,
`staffing.qualification.administer`, `staffing.qualification_holding.administer`,
`group.location.administer`), through the product's own SPEC-06 L4 path under an
organization-scoped context. Where a live DENY row exists it is **closed first** and a new
window opened — the product's own way to change a grant — because writing an overlapping
row collides with `capability_grants_no_overlapping_window`, an exclusion constraint doing
its job.

---

## 4. (E) The hardening register, item by item

| Item | Disposition | Evidence |
| --- | --- | --- |
| **NR-15** capture widening | **DONE.** `scripts/sbx/capture.mjs` retains the full output, the command and the exit code of any failing run under `.evidence-scratch/fixture-regression/`. Red-cased: restoring the truncation fails `scripts/red-cases/nr15-capture/check.mjs` | §4a |
| **NR-15** disposition | **CANNOT BE STATED YET** — the extended battery has not run. See §9.4 | §9.4 |
| **NR-16** scanner | **DONE.** Bare-line detector + red arm + mutation control + a baseline pinned by path AND count over eleven pre-existing files | §4b |
| **NR-18** NUL repair | **PARTIAL BY CONSTRUCTION.** `EV-M3-AUTHN/INDEX.md` repaired byte-exactly and its baseline entry removed. The two `docs/fable/control/**` instances are **Fable's** — §6g's allowed files exclude them — so "(baseline → empty)" is unreachable from inside this packet. **NR-18 stays open** | §4c |
| **NR-18** magic-byte hardening | **DONE**, with a mutation control showing the pre-hardening behaviour skips the same file | §4c |
| **NR-19** reclaim orphan | **DONE.** `release()` force-unlocks its own pool BEFORE recording the release | §4d |
| **Runner:** `No test files found` as ERRORED | **DONE**, with its own control and a red case | §4e |
| **Runner:** `dist/__red_case__*` sweep | **DONE** in `revertViolation`, by name rather than by extension list | §4e |
| **Runner:** network-guard/build ordering (R-2) | **DONE** — the bundle is built once up front, so the ordering is a property of the runner rather than of the order two batteries happened to run in | §4e |
| **Nine phantom citations** | **DONE**, each retargeted by reading the assertion. Two produced findings of their own | §4f |
| **Screenshot regeneration** (EV-M4-004 cross-snapshot) | **NOT DONE** — it needs the browser run that clause (A) owns | §9.1 |
| **`solverStatus` on list/comparison** (F-12) | **DONE** | §2d |
| **R-10** raw DELETE in `periodic.test.ts` | **DONE** — replaced by the production drain, with `drainQueue` taking a signer | §4g |

### 4a. NR-15

The register's diagnosis is one sentence: *"the gate truncates assertion output so the
actual failure was never captured."* That was literally true — the gate filtered a
failing run to at most twelve lines matching two narrow patterns. Five packets of
reproductions produced a test **name** and no assertion.

`writeCapture` lives in its own module so it can be falsified. Its control feeds it a
synthetic failing run whose output contains an assertion body the old filter would have
dropped, and requires it back byte for byte, along with the command and the exit code —
because a capture nobody can re-run is a transcript of nothing.

### 4b. NR-16

The tenant-table detector required a quote **earlier on the same line**, so the same
direct query became invisible by pressing Enter. The bare-line detector matches a line
that IS a bare SQL fragment naming a tenant table, with no quote anywhere on it.

Eleven existing files carry legitimate multi-line SQL inside a unit of work; they are
baselined **by path and by count** (audit/checkpoints 1, audit/reader 1,
audit/verification 2, authn/store 19, schedule-publication.route 6, outbox/dispatcher 3,
rules/service 2, schedule/publication 4, schedule/review-identity 7,
solver/canonical-input 2, solver/snapshot-store 2). A pinned file that acquires a second
one fails; a pinned file that loses its last one fails too, so the list shrinks
deliberately.

The baseline is **opt-in**: passed explicitly by the real `apps/api/src` scan and
deliberately not by any fixture scan, because a baseline is a statement about one
directory's history.

### 4c. NR-18

Repair at offset 1812, inside an inline-code span, in a sentence that reads "Converted
to the `<NUL>` JS escape" — the escape in the prose and the raw byte in the code, the
same shape M4-002 found in `generators.ts`. File 17 518 → 17 521 bytes; NUL count 1 → 0;
git will text-diff that file again.

The magic-byte hardening closes the rename bypass M4-003 recorded and left. Mutation
control measured: with the sniff reverted to extension-only, the misnamed fixture is
**skipped and the gate PASSES** — so the arm is not decorative.

### 4d. NR-19

The close is at `release()` rather than in the sweep, and the choice is argued in the
code: a sweep that re-examined released pools would need a marker column this migration
set cannot add, and without one it would force-unlock the same pools for ever. A pool
unlocking its **own** abandoned jobs needs no marker and cannot take a live peer's lease.
Unlock first, record second — a crash between them leaves the pool *unreleased*, which
the stale sweep still catches.

### 4e. The runner

The ERRORED detection is the one with the most leverage, because every other case's
falsifiability rests on it: `vitest run typo.test.ts` exits **non-zero**, so an arm whose
path is misspelled recorded "gate failed as required" and printed **PROVEN** while
proving nothing.

Four red cases added (63 total). Three of them are over **controls** — the runner's own
detection, the NUL gate's sniff, the capture widening. A defect in any of those does not
fail a build; it makes a build stop being able to fail, which is strictly worse.

### 4f. The phantom citations

All nine retargeted. Two produced findings:

* `packages/contracts/src/solver/snapshot.ts` claimed a `constituent-kind-parity` test
  asserted the wire enum and `SNAPSHOT_CONSTITUENT_KINDS` were the same list. **No test
  anywhere imported that constant** — the claim had nothing behind it. Written rather
  than withdrawn: `apps/api/test/solver/constituent-kind-parity.test.ts`, 13 kinds,
  identical on both sides;
* `authn/cookies.ts` claimed its posture test "drives every route that touches the
  cookie". It drives two of the three writer routes — the password-reset completion path
  is exercised without a `Set-Cookie` assertion. Corrected to what is asserted, because a
  claim wider than its coverage is the same defect class as a dead path.

**And the control that ends the class:**
`apps/api/test/architecture/citation-integrity.test.ts` sweeps both forms over every
tracked source and fails the build — **222 full-path and 76 basename citations checked,
all resolve.** Four rounds of repairing instances is what a missing control looks like.

A historical mention ("which has never existed") is exempted within two lines, with the
comment markers stripped so a wrapped sentence reads as one sentence. Deleting the record
of a previous repair to satisfy the check would be the check making the codebase worse.

### 4g. R-10

`drainQueue` now accepts a signer — the fix **at the shared resource** that EV-M4-002
§21d said it needed ("a drain that cannot see `audit.*` jobs is a drain that cannot
establish the precondition it exists to establish"). `periodic.test.ts` no longer clears
its backlog with a statement the system cannot issue; the jobs are executed.

---

## 5. Commands run, with real exit codes

Every command below was run in this worktree. Transcripts are in `transcripts/`.

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 01 | `corepack pnpm install` | **0** | 467 packages |
| — | `tsc -b --force` (after each change) | **0** | clean |
| — | `eslint .` | **0** | clean |
| — | `vitest run` (all five projects) | **0** | **2091 passed / 14 skipped**, 164 files |
| — | `vitest run apps/api/test/builds/concurrency-recovery-matrix.test.ts` | **0** | **40 passed** |
| — | `node scripts/gates/raw-nul-scan.mjs` | **0** | 1201 text files scanned, 249 skipped by extension AND magic bytes, 2 baselined |
| — | `node scripts/gates/raw-nul-scan.mjs --dir …/raw-nul-magic/fixture` (violation present) | **1** | fails as required |
| — | the same, with the sniff reverted to extension-only | **0** | **the mutation control** — the arm is not decorative |
| — | `node scripts/red-cases/runner-signature/check.mjs` | **0** | 2 detected, 3 correctly left alone |
| — | `node scripts/red-cases/nr15-capture/check.mjs` | **0** | full output, command and exit code retained |
| 02 | `corepack pnpm check` | **1** | **15/17.** `unit` failed on the citation sweep matching its own examples; `import-boundary` failed on an import CYCLE. **Both were real findings** — see §5a. Retained deliberately: a battery that only ever appears green is the thing this repository does not do |
| 03 | `corepack pnpm exec vitest run` (after the cycle fix) | 1 | 2092 passed, the 0019 cycle's grantee assertion outstanding |
| — | `vitest run …/migration-0019-populated-cycle.test.ts` | **0** | **2 passed** |
| 04 | `corepack pnpm check` | **0** | **17 gates: 17 passed, 0 failed.** unit 244 s, axe 216 s |
| 05 | `corepack pnpm red-cases` | *interrupted* | **26 arms started, 25 completed, 24 "gate failed as required", 0 `GATE STILL PASSED`, 0 `GATE FAILED`, 0 `ERRORED`.** Killed by the session harness at ~50 minutes, not by a failure — see §5b |
| 06 | the three script-level new arms, standalone, both directions | **0 / 1** | see below |
| 07 | the NR-16 arm, standalone, both directions | — | GREEN 12/12 · RED **3 failed** · restored 12/12 |

### 5a. What `check` found that the per-file runs could not

* an **import cycle** `errors.ts → staleness.ts → service.ts → errors.ts`. A type-only
  import does not make a cycle benign; dependency-cruiser counts it, and it is right to.
  Repaired by moving the pure half to `builds/constituent-diff.ts`;
* the **citation sweep swept its own examples** — its regex docblocks and its RED arm's
  two fabricated paths. Exempted by one spelled-out path, asserted in the red arm.

Both are recorded here rather than smoothed over, because run 02 is the reason run 04
means anything.

### 5b. The red-case battery was INTERRUPTED, and what that leaves

The session harness stopped the detached run at ~50 minutes, part-way through
`draft-invisibility`. `revertViolation` runs in a `finally`, and a kill skips it — so the
tree was left with `apps/api/src/http/routes/schedule-views.route.ts` patched. This is the
documented hazard (EV-M4-002 §22c(1)), and it was handled as that record prescribes:

```
git status --porcelain            ->  M apps/api/src/http/routes/schedule-views.route.ts
git checkout -- …schedule-views.route.ts
find packages apps -name '__red_case__*'   ->  (empty, after removing one leftover)
node scripts/gates/raw-nul-scan.mjs        ->  PASS
tsc -b --force                             ->  EXIT 0
```

**The full 63-arm battery is therefore NOT claimed.** What IS claimed is the partial run
above and the four new arms proven standalone in both directions (transcripts 06 and 07):

| New arm | GREEN | RED | Notes |
| --- | --- | --- | --- |
| `red-case-runner-errored-signatures` | PASS (2 detected, 3 left alone) | **FAIL** — both signatures undetected once the list is emptied | |
| `nr15-capture-widening` | PASS | **FAIL** — 6 problems, first: "the ASSERTION was not retained — this is exactly the truncation NR-15 names" | |
| `raw-nul-magic-bytes` | with the sniff: **FAIL** (the misnamed file is scanned) | extension-only: **PASS** — the bypass, measured | inverted polarity; the mutation control IS the proof |
| `nr16-bare-line-scanner` | 12/12 | **3 failed** with the detector removed | restored: 12/12 |

**Batteries not run in the FIRST session, and therefore claimed for nothing there:** the
complete `red-cases` battery, `fixture-regression` under the widened capture, `sbx`, and
the architecture/fable/research validators. **All four have now run — see §14**, which is
the record that supersedes this paragraph.

---

## 6. (F) Current-state documentation

`docs/dev-setup.md` updated: the gate table is now the real **seventeen** (it said
twelve); the red-case count is the real **63** (it said fourteen); §8 gains the
`SP_SOLVER_WORKER_COMMAND` instruction with the FAD-7/FAD-10 CI condition stated as a
condition rather than a footnote; two new sections cover where evidence goes, the four
acceptance-time batteries and the serial discipline, and **what the current tree does and
does not do**.

There is no `README.md` at the repository root, so the packet's "`docs/dev-setup.md`/README
current-state" is discharged in the one file that exists — disclosed rather than silently
narrowed.

---

## 7. The current-state summary Fable lifts into doc 36

**What M4 proved.** A schedule can be produced by the engine and only by the engine
(I-05): a period's demand, profiles, qualifications, rules and pins assemble into one
immutable canonical snapshot with every constituent revision cited; a deliberately
infeasible problem comes back `infeasible` naming the hard rule that made it so, and a
worker's unparsable answer comes back `failed` — two different states, proven distinct;
one hundred per cent of twenty-two injected hard violations are detected and explained in
domain terms; a protected assignment survives a progressive stage exactly; a real CP-SAT solve
runs in a separate Python subprocess that holds no database credential; the candidate is
re-validated by an independent checker that shares no code with the model; the build
moves through a sixteen-state server-authoritative machine whose transitions, fencing and
append-only result tables are enforced by the database against every writer including the
owner; a stale worker's answer cannot land; a dead worker is reaped and its build is said
to be dead in the honest word; a selected candidate is written into a **new** draft
version through the one assignment write path, and never into a published one. As of this
packet, dispatch runs on a durable queue under a per-organization concurrency cap, and a
build whose inputs have moved can never silently become the current draft.

**What M4 did NOT prove.**

* **No benchmark band.** SPEC-04 §7 leaves every band except `hard_violations = 0`
  undefined until the corpus is run. That is M6. No surface renders a threshold.
* **No image, no digest, no reproducibility claim.** `Dockerfile.solver` is authored and
  has never been built. Every measurement was taken under a local venv interpreter.
* **The 14-step critical path has not been driven end to end through a BROWSER against
  the real stack, and cannot be**: the shipped web client has never sent the context
  header every capability route requires, and no API response returns the counters it
  would need to construct one. Every step is proven at the API and in the database; the
  join between the browser and the server has never been exercised, and §12 is the
  measurement and the escalation.
* **The e2e suites intercept the API**, as every spec in that directory does. Server
  behaviour is proven separately over HTTP and in raw SQL. The point above is why that
  is not merely a convention.
* **`pnpm red-cases` is RED on this tree** — 60 of 63 arms proven, three not: two
  scoring defects in arms this packet itself added, one undiagnosed GREEN failure (§14c).
* **`schedulepoint-research/validate.sh` FAILS, pre-existing** — eight directory
  expectations the research corpus has never satisfied (§14a row 09).
* **NR-15 REPRODUCED and stays OPEN** (§9, §14b).
* **M3R remains PAUSED.**
* **No production-readiness claim, and no compliance claim of any kind.**

**Standing CI conditions.** Build `Dockerfile.solver` and record its digest; re-run the
suite against the pinned Python 3.12 image. Both predate this packet and both remain. To
them this packet adds one: **the critical path cannot be gated in CI until the browser
client can declare a context** (§12).

---

## 8. Deviations from the packet, stated

1. **`scripts/gates/no-tenant-access-outside-unit-of-work.mjs` does not exist.** §6g's
   Read-first and Allowed-files rows name it. The I-15 scanner lives at
   `apps/api/test/support/tenant-access-scan.ts` and is driven by
   `apps/api/test/architecture/no-tenant-access-outside-unit-of-work.test.ts`. The named
   hardening is unambiguous, so it landed on the real scanner. Reported rather than
   invented.
2. **NR-18's "(baseline → empty)" is unreachable from this packet's globs** — see §4c.
   The instruction and the allowed-files row contradict each other; the allowed-files row
   was followed.
3. **No `README.md` exists at the repository root** — see §6.
4. **`apps/api/src/worker.ts` was not created.** §6g permits `apps/api/src/{index,worker}.ts`
   for task registration; the registration fits in `index.ts` beside the outbox runner,
   and a second process entry point with no deployment asking for it would be scaffolding.
5. **Clause (A) was not delivered and was ESCALATED instead** — §12, with the obstacle
   measured rather than asserted.
6. **The previous session's note that the screenshot regeneration needed clause (A)'s
   browser run was wrong.** It needed a NARROWER run of an existing mocked spec, and it
   is done (§13). Corrected rather than carried forward.
7. **The `pnpm sbx --refresh` run rewrote six ACCEPTED bundles' artifacts, and they were
   reverted.** `EV-M2-SBX/{sbx-001,sbx-002,sbx-004,scenario-report}`,
   `EV-M3-AUTHN/{sbx-005,sbx-006}` and `EV-M3-PUBLICATION/sbx-018` are regenerated by
   every SBX run and none of them is in §6g's allowed-files row. Only the three NEW
   artifacts — `EV-M4-005/sbx-01{5,6,7}-*.txt` — are kept. The consequence, stated
   because it is a real gap: **the combined `scenario-report.txt` that names all nine
   scenarios exists only in `.evidence-scratch/`**, and the tracked one still describes
   six. Fable's post-acceptance sweep is where that is repaired, from the same command.
8. **`corepack pnpm red-cases` was not re-run after §14b's repair.** The complete 63-arm
   run in §14a predates it by one commit. The repair touches `apps/api/test/support/queue.ts`
   and one local drain in `apps/api/test/audit/crash-restart.test.ts` — test support that
   no red-case arm mutates — but the battery is nonetheless one commit stale and saying so
   is cheaper than implying otherwise.

---

## 9. NR dispositions, stated with their evidence

| Item | Disposition | Evidence |
| --- | --- | --- |
| **NR-15** | **REPRODUCED — OPEN, and the packet paused on it** per doc 35 §6g ruling (3). NOT retired, and not "resolved" | §14b. Six of seven fixed seeds failed; the widened capture retained every assertion; the dominant cause was diagnosed and repaired from that capture, and one residual cluster is named and left open |
| **NR-15** capture widening | **DONE and VINDICATED.** It is the reason the reproduction is a diagnosis rather than a test name | §4a, §14b |
| **NR-16** | **CLOSED**, subject to the eleven-file baseline being a record rather than an amnesty — pinned by path AND count, and the shrink rule is red-cased | §4b |
| **NR-18** | **OPEN.** One of three baselined instances repaired byte-exactly; the other two are in `docs/fable/control/**`, which §6g's allowed-files row expressly withholds from this packet. The gate's magic-byte hardening is DONE, with a mutation control | §4c |
| **NR-19** | **CLOSED** at `release()`, with the reclaim's semantics unchanged | §4d |

**Why NR-15 is not retired.** Ruling (3) makes retirement conditional on "zero
reproductions across M4-005's runs AND the M4-000A→M4-004 record". M4-005's own run
produced six. The condition is not met, the register item stays open, and retiring it on
the strength of the runs that happened to pass would be the precise failure the register
exists to describe.

---

## 10. Where the rest of this bundle is

Sections 1–9 are the previous session's record, corrected where this one measured
something different. The four below are this session's work:

| §11 | **(C)** SBX-015/016/017 — the three sandbox scenarios |
| --- | --- |
| **§12** | **(A)** the critical-path e2e, ESCALATED, with the obstacle measured |
| **§13** | the scoped EV-M4-004 screenshot regeneration |
| **§14** | **(F)** the full acceptance battery — including what failed |

---

## 11. (C) SBX-015, SBX-016 and SBX-017

Three scenarios, on the SPEC-16 harness, each with a `ProbeFalsified` control over
an **extracted** oracle — the same function the scenario runs, so the probe cannot
falsify a different implementation than the one that shipped. Semantics are doc 35
§6g ruling (1), verbatim from report 21 §11.

**The required set rises 6 → 9.** `pnpm sbx` now requires SBX-001, 002, 004, 005,
006, 018, **015, 016, 017**. The **SBX-004 sweep floor is UNCHANGED at 54 registry
/ 53 sweep**: this packet's only migration (0019) creates no table, so no tenant
table joined `TENANT_TABLES` and nothing raised the floor. Reported because §6g's
Acceptance row asks for it either way.

All three are `gateRequired: true`. Each is claimed by a G-PROD gate — report 24
§3.2 (SBX-015, CAP-015..018), §3.4 (SBX-016, CAP-059), and §2 item 6 (SBX-017) —
so an `EVIDENCE_BLOCKED` on any of them fails the run rather than resting.

### 11a. SBX-015 — execution, the distinction, regeneration, retained history

`LIVE-SIM`. Three real dispatches against the venv CP-SAT worker, then two arms
that need no solver at all.

| Arm | What it did | Measured |
| --- | --- | --- |
| **1 execution** | a real solve, end to end | `completed` / **`OPTIMAL`**, 1 candidate assignment, `usable = true` (the INDEPENDENT checker, not the worker's opinion) |
| **2 infeasible** | a HARD `AvoidDate` on the one date the period requires staffed | `infeasible` / `completed` / **`INFEASIBLE`**; explanation state `EXPLAINED_MINIMAL`; conflicting rule keys **`[__demand__, sbx015_no_staffing_on_the_required_date]`** |
| **3 failed** | the hostile-worker fixture in `garbage` mode | `failed` / `rejected`, `usable = false` — and a DIFFERENT state from arm 2 |
| **4 regeneration** | a retry | a NEW `build_runs` row citing the original in `retry_of_build_run_id` at `retry_attempt` 1; the in-place edge `infeasible → draft_configuration` refused by the transition table AND by the database |
| **5 retained history** | after the retry | 4 runs still readable in their settled states, the original's result row intact, its `claim_epoch` unspent |

**Why the infeasible arm is constructed the way it is.** The obvious fixture —
demand larger than the eligible population — never reaches the solver:
`readinessFindings` raises `eligible_capacity_below_demand` and `submitBuild`
bounces the run to `draft_configuration` before anything is dispatched. That would
prove the readiness check, not infeasibility. A HARD rule is the honest lever
precisely because **readiness does not evaluate rules** (`readiness.ts`: "It does
not evaluate a single rule"), so the run queues, the solver runs, and the solver
proves the problem has no answer.

**Report 24 §3.5 — "every `infeasible` names the conflicting hard constraints in
domain terms" — is measured rather than asserted.** The explanation is READ off
`build_run_results` and the scenario requires the conflicting set, when non-empty,
to contain the rule that was actually injected. It does:
`sbx015_no_staffing_on_the_required_date`, beside `__demand__` — T1/T2 identified
both halves of the contradiction, which is the correct answer.

**The oracle** is outcome honesty: `infeasible` is a statement about the PROBLEM
and `failed` is a statement about the SYSTEM, and the two states must differ. **The
probe** relabels the infeasible outcome as `failed` — the one conflation SPEC-04
§2 forbids — and requires the oracle to reject it. It is the realistic failure: a
scheduler told "the build failed" retries it, and a scheduler told "no schedule
exists under these constraints" changes the constraints.

### 11b. SBX-016 — 22 of 22, detected AND explained

`apps/api/test/sbx/injections-016.ts` is the fixture report 24 §3.4 asks for: "a
fixture with deliberately injected defects", one per kind in
`EVALUATED_HARD_RULE_KINDS`. **22/22 detected — 100%.**

Four conjuncts, all counted rather than judged:

1. **totality** — the injected set is compared against `EVALUATED_HARD_RULE_KINDS`
   itself, never against a hand-written number, so a kind added to the checker
   later cannot leave the sweep at 21 of 22 while the percentage still reads 100;
2. **detection** — each injection produces at least one `breach` finding whose
   `nodeKind` is that kind and whose `ruleKey` is the injected key. A finding of
   the wrong kind is not a detection of this one;
3. **explained in domain terms** — the breach explanation must name every domain
   identifier the injection declared: the membership handle, the date, the
   shift-type code, the staff-group or valid-group id, the pick position. This is
   the half the gate spells out by writing "and explained", and it is mechanical: a
   detector answering *"rule 7 was violated"* passes (2) and fails here;
4. **non-vacuity** — every injection carries a SATISFIED twin, the same world with
   one fact moved, which must produce **zero** findings for that rule. Without it a
   checker that breached on everything would also score 100%.

The three injections whose weekday arithmetic decides the answer (`WeekdayFteLimit`,
`PatternRule`, `AlternatingWeek`) assert their weekday facts with `weekdayOfDate`
in the run rather than trusting a comment.

**The build boundary is proven as a chain, not a function.** One injection is
carried through `validateCandidate` → `conflictsOf`:

```
validateCandidate: usable=false, rejections=[hard-violation], hardViolations=1;
  membership 6666… is assigned on 2031-06-05, which this rule forbids
conflictsOf -> class=hard-breach severityRank=1 blocksApproval=true
  code=rule_breached subject=inj_anchor_avoid_date; detail carried through
  byte-identically from the checker
```

The anchor snapshot staffs its demand EXACTLY, so the hard-rule breach is the only
reason the checker can refuse — `rejections` is exactly `[hard-violation]` and
nothing else. A snapshot with unmet or over-filled demand would also raise
`demand-not-met` and the assertion would stop meaning anything.

**Two named `EVIDENCE_BLOCKED` sub-scenarios, neither absorbed into the pass:**

* **per-conflict REMEDIATION.** Report 24 §3.4 asks for "severity, explanation, and
  remediation". This system produces severity (`severityRank`), explanation
  (`detail`, in domain terms) and the blocking decision (`blocksApproval`) — and
  **no remediation text**. There is no remediation field on `BuildConflict`
  (`packages/contracts/src/builds/lifecycle.ts`) and none is invented here;
* **injecting `PickPositionRestriction` through the CANDIDATE path.** RK-RULING-04
  makes a solver-produced row carry `pickPosition: null` by construction, which
  satisfies the restriction vacuously. The kind is injected and detected at the
  **checker** boundary, where a real draft position exists; it is unreachable at
  the candidate boundary by design, not by gap. §6g requires an uninjectable kind
  be NAMED, and this is the naming.

**The probe** blinds one kind's breach findings and requires the oracle to report
an undetected violation — not "the checker crashed", but "the checker quietly
missed one kind and the percentage still read 100 because nobody counted the
kinds".

### 11c. SBX-017 — preserved EXACTLY, and circulated without publishing

`LIVE-SIM`. Two real solves and the whole progressive lifecycle through the
production services.

1. **stage 1** solves for real, is reviewed, approved and written into a **new**
   draft through `applyCandidateToNewDraft`; the source draft is untouched;
2. one resulting assignment is **pinned** through `setPin`;
3. **stage 2** is a progressive build citing stage 1 in `parent_build_ids` and that
   identity in `protected_assignment_identities`. The canonical input carries it as
   a **pinned fixed input** — asserted from the stored snapshot, so the protection
   is an INPUT rather than a hope;
4. the full lifecycle: `completed → reviewed → progressively_extended → reviewed →
   approved → applied_to_draft_schedule`;
5. **preserved EXACTLY** — the protected identity is present on the new draft with
   the SAME membership, the SAME date, the SAME shift type, and still pinned.

The word doing the work is *exactly*. An identity that survives but changes hands,
or moves date, or loses its pin, satisfies any presence-only check and is a
silently re-decided assignment — which is the "explicit unlocking" report 21 §5
requires to be a deliberate act. **The probe** moves the protected assignment to
another membership and requires the preservation oracle to reject it.

**Partial circulation** is the second half, and it is partial by measurement: the
draft staffs **1 of the period's 7 dates**, reaches `in_review` through the
EXISTING M3 path (`transitionVersion`), and afterwards the period is still
`planning` with **0 publication records** and **0 current published assignments**,
and the version is not `is_current`. A review is not a publication, and the arm
would be vacuous over a draft that happened to be complete — so the partiality is
asserted rather than assumed.

---

## 12. (A) The critical-path e2e — the ESCALATION, and the obstacle as it was measured

> **STATUS SUPERSEDED BY §17.** FAD-48 ruled this escalation and the join is now built and
> running. Everything below is retained EXACTLY as it was written, because it is the
> measurement the ruling rests on and because a bundle that deletes the escalation once it
> is resolved teaches nobody why the resolution was necessary. Read "not delivered" below
> as "not delivered AT THE TIME OF WRITING".

**Not delivered, and deliberately not approximated.** doc 35 §6g's Escalate-if row
ends with "anything passable only by weakening", and its Included (A) is explicit
that the suite drives "the REAL web app + API + PostgreSQL + worker + M4 feature
APIs" with "mocks only for external providers that do not exist in M4 (none are
needed)". The obstacle below makes that suite unbuildable inside this packet's
allowed files, and every way of building it anyway would have made the suite prove
something false.

### 12a. The obstacle, in one sentence

**The shipped browser client cannot make an authorized request to the real API at
all**, because every capability-bearing route requires the client-declared context
header (SPEC-01 §2.2, I-14) and `apps/web/src/api/client.ts` has never sent one.

### 12b. The measurement, not the inference

Every request the web application makes — `apps/web/src/api/client.ts:56`:

```ts
const response = await fetch(`${API_PREFIX}${path}`, {
  ...init,
  headers: { accept: 'application/json', ...init?.headers },
  credentials: 'same-origin',
});
```

`accept`, whatever the caller adds (only ever `content-type`), and a same-origin
cookie. There is no context header, and no other `fetch` in `apps/web/src`.

What the server does with that — `apps/api/src/http/context/middleware.ts:211`
runs for every route carrying a capability declaration, which the `route-policy`
gate makes mandatory (I-02, 112 registered routes), and it reaches
`apps/api/src/http/context/declared.ts:79`:

```ts
const raw = request.headers[CONTEXT_HEADER];
const headerValue = Array.isArray(raw) ? raw[0] : raw;
if (typeof headerValue !== 'string' || headerValue.length === 0) {
  return { ok: false, problem: 'CONTEXT_HEADER_MISSING' };
}
```

Every tracked file that mentions the header at all:

| File | Role |
| --- | --- |
| `apps/api/src/http/context/declared.ts` | the reader |
| `packages/contracts/src/context.ts` | the name and the schema |
| `packages/contracts/src/index.ts` | the re-export |
| `apps/api/test/support/http.ts` | **test** support — `contextHeaders()` |
| `apps/api/test/sbx/scenarios.ts` | **test** |
| `apps/api/test/http/context-surface.test.ts` | **test** |

No sender under `apps/web/**`. `ingress.nginx.conf` injects nothing either — its
three `proxy_set_header` directives are `Host`, `X-Correlation-Id` and the
websocket upgrade pair.

**And the other half is missing too.** A client could not construct the header even
if it wanted to: **no API response carries the context counters back**.
`organizationVersion` appears in exactly three places in the whole tree —
`declared.ts` (reading the header), `snapshot.ts` (reading ground truth), and
`context.ts` (the schema) — and none of them is a response body. There is nothing
for a browser to learn a declaration from.

### 12c. Why this was invisible until now

Every spec in `apps/web/e2e/**` intercepts the API with `page.route(...)` and
fulfils fabricated JSON. Each spec's own docblock says so; `builds.spec.ts` puts it
plainly — "this file proves the **interface** behaves correctly for each response.
That the server produces those responses … is proven separately, over HTTP and in
SQL." Both halves are true and both are proven. **What has never been exercised is
the join between them**, and the join is where the missing feature lives. §6g
ruling (5) is the first requirement in the programme to ask for it, which is
exactly why it surfaced here.

### 12d. The three ways to build it anyway, and why each was refused

1. **Add the header to `apps/web/src/api/client.ts`.** This is the real fix, and it
   is a **product feature**, not test plumbing: the client needs a context-version
   store, the API needs to return the counters, and SPEC-01 §2.2's declare/verify
   contract needs a client half. `apps/web/src/api/**` is not in this packet's
   Allowed-files row (`apps/web/src/builds/**` is), and inventing the client half of
   an authorization control inside an integration packet is precisely the
   improvisation §7 says a sub-agent is rejected for.
2. **Have Playwright add the header with `route.continue({ headers })`.** No
   response would be fabricated, so it is not a mock — but the suite would then
   assert that the real web app drives the real API when the real web app cannot,
   and the header would have to carry LIVE counters the harness read from the
   database on the app's behalf. The suite would be a picture of a system that does
   not exist. This is the "passable only by weakening" case.
3. **Deliver only the API half** — the same 14 steps over real HTTP, real
   PostgreSQL, real worker and real CP-SAT, with no browser. Honest, and genuinely
   valuable, but it is not clause (A): (A)'s subject is `apps/web/e2e/critical-path.spec.ts`
   at both viewports with axe green and every interaction budgeted, and none of
   those three properties exists without a browser. It is offered below as the
   continuation's first item rather than smuggled in as a substitute.

### 12e. What Fable has to decide

The minimal change that unblocks (A), stated so the decision is about scope rather
than about discovery:

* **API** — return the three counters and the session epoch on authorized
  responses (or on a dedicated context endpoint), so a client can learn a
  declaration. `apps/api/src/http/context/**` plus a contract addition;
* **web** — a context store in `apps/web/src/api/client.ts` that holds the last
  learnt counters per (organization, group) and declares them on every request,
  with the 409/412 re-learn path SPEC-01 §2.3 implies;
* **then** clause (A) as written, unchanged.

Until that exists, the honest statement in doc 36 is: **the 14-step workflow has
been proven step by step at the API and in the database, and has never been driven
through the browser against a real server, because the browser client cannot yet
declare a context.**

### 12f. What this does NOT change

The scoped screenshot regeneration §6g attached to (A) did not need the real stack
— it is a capture of a mocked comparison surface — and it is **done** (§13). The
axe and request-budget gates continue to run over all ten existing specs, at both
viewports, unchanged.

---

## 13. The scoped screenshot regeneration — those two files, and no others

The last open item on the hardening register (§4's table). EV-M4-004's
`build-comparison-cross-snapshot.{desktop,mobile}.png` predated the F-01/F-02 repair, so
an accepted bundle carried a picture of behaviour the code no longer has.

It did **not** need clause (A)'s browser run after all, and the previous session's note
that it did was wrong: the capture is of a comparison surface the existing `builds.spec.ts`
already drives under interception. What it needed was a **narrower** run:

```
SP_EVIDENCE_REFRESH=1 node scripts/run-in-workspace.mjs apps/web \
  playwright test builds.spec.ts -g "AC-35"
  ->  2 passed (desktop + mobile), EXIT=0
```

Scoped by test title rather than by spec file, and that is the whole point.
`apps/web/e2e/support/evidence-target.ts` records why: "a PNG re-encoded from a fresh
render differs byte-for-byte even when the page is identical". A refreshed run of the
whole spec would have rewritten all fourteen EV-M4-004 captures plus the EV-M4-003 ones,
and §6g's "others byte-identical" clause would have become unprovable rather than merely
unproven.

Measured afterwards rather than asserted:

```
git status --porcelain
 M docs/evidence/EV-M4-004/screenshots/build-comparison-cross-snapshot.desktop.png
 M docs/evidence/EV-M4-004/screenshots/build-comparison-cross-snapshot.mobile.png

git diff --stat
 desktop  Bin 114194 -> 155726 bytes
 mobile   Bin 347157 -> 534506 bytes
 2 files changed
```

Two files. Nothing else under `docs/evidence/**` moved. The new capture shows the
post-repair surface: the refusal stated in words, the measurements rendered SEPARATELY
per candidate (F-01) each against the objective it was measured under, and "Where they
differ" saying no comparison was made rather than presenting an empty table that would
read as agreement (F-02).

---

## 14. (F) THE FULL BATTERY — what ran, what passed, and what failed

Serial, one command at a time, `uptime` checked at every step, every transcript in
`transcripts/`. This is the first complete run of the acceptance battery in this packet:
the previous session's red-case run was interrupted at arm 26 of 63 and correctly
claimed nothing.

### 14a. The battery, in order

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 01 | `corepack pnpm check` | **0** | **17 gates: 17 passed, 0 failed.** unit 258 s, axe 217 s |
| 02 | `corepack pnpm red-cases` | **1** | **63 arms, ALL RUN — 60 proven, 3 not proven.** The first complete run; the three are §14c |
| 03 | tree hygiene after the red-case run | — | `git status --porcelain` **empty**; `find … -name '__red_case__*'` **empty** in `dist/` and everywhere else. The interrupted-run hazard EV-M4-002 §22c(1) records did not occur |
| 04 | `corepack pnpm fixture-regression` | **1** | **6 of 7 fixed seeds FAILED.** This is NR-15's reproduction, and §14b is the diagnosis the widened capture made possible |
| 05 | `corepack pnpm sbx` | **0** | **scenarios required 9 · executed 9 · passed 9 · failed 0 · blocked 0 · vacuous 0 · probe-error 0 · not-runnable 0** |
| 06 | `migrate:cycle:embedded` (`0001`–`0019` by name) | **0** | **MIGRATION CYCLE CLEAN — up → down → up → down → up**, both directions twice, all nineteen |
| 07 | `python3 docs/architecture/validate.py` | **0** | 95 assertions, 95 passed, 0 failed |
| 08 | `python3 docs/fable/validate.py` | **0** | 36 assertions, 36 passed, 0 failed |
| 09 | `bash schedulepoint-research/validate.sh` | **1** | **FAILS, and it is PRE-EXISTING** — eight `MISSING DIR` lines for `reports/inbox` and the seven `screenshots/*` directories. `git ls-files schedulepoint-research` returns **zero** screenshot paths and zero `reports/inbox` paths, and `validate.sh` has not been touched since the initial research commit. Every required FILE and the manifest JSON pass. Nothing in this packet touches `schedulepoint-research/**`; the failure is the research corpus's own unmet directory expectation, reported rather than absorbed |

### 14b. NR-15 REPRODUCED — and the capture WAS the diagnosis

doc 35 §6g ruling (3): "if it REPRODUCES, the packet pauses on it and the capture is now
the diagnosis." It reproduced. Six of seven fixed seeds, every one captured in full:

```
FAIL  seed 1        290.1s  1 failed | 1413 passed | 14 skipped
FAIL  seed 7        245.1s  1 failed | 1413 passed
FAIL  seed 42       334.7s  4 failed | 1410 passed
FAIL  seed 424242   334.4s  4 failed | 1410 passed
FAIL  seed 20260803 335.9s  4 failed | 1410 passed
FAIL  seed 31337    296.5s  1 failed | 1413 passed
PASS  seed 99991    204.0s  1414 passed
```

**The capture is the entire difference between this and the last five packets.** The
register's own diagnosis of NR-15 was "the gate truncates assertion output so the actual
failure was never captured" — five packets of reproductions had produced a test NAME and
no assertion. This run produced, for every failing seed, a full transcript with the
command, the exit code and the assertion body, retained under
`.evidence-scratch/fixture-regression/seed-*.txt`. Reading `seed-1.txt` gave the cause in
one line:

```
Error: outbox-dispatch-finalize: the queue still holds 2 job(s) after 45000 ms
```

**Two**, not the five §1c repaired — so a second producer, and a more general defect one
level down: **`drainQueue` was waiting for a job it had no handler for.**
`startOutboxRunner` registers `outbox.dispatch` and, with a signer, `audit.checkpoint`
and `audit.verify`. It has no handler for `build.solve`. Its loop waited for a count over
**all** jobs to reach zero. A `build.solve` job in the backlog therefore made that loop
unsatisfiable — a deadlock by construction, not a race — and under a shuffled file order
any file that submits a build poisons every drain that follows it.

The repair is one idea: **a drain waits on the jobs it registered a handler for, and only
those.** `drainableJobCount` counts the drainer's own `outbox.*` / `audit.*` namespace
rather than excluding today's one foreign task, so a task added inside the namespace joins
the count automatically and a task added outside it is correctly ignored — an exclusion
list would have to be maintained by whoever adds the next queue, which is how the defect
arrived. `crash-restart`'s local copy of the drain is repaired identically.

**The precondition is not weakened, and that matters.** Block B needs the queue empty so
its worker leases the job it published rather than somebody else's — and its worker
registers `outbox.dispatch` alone, so a `build.solve` job could never have been leased by
it. Excluding it makes the precondition satisfiable without making it weaker.

One more correction came out of the same capture: `drainBuildSolveQueue` originally THREW
when the backlog named a build another file had in flight. Under `--sequence.shuffle.files`
that is a legitimate state, and a teardown that fails because somebody else is working has
invented a coupling. It now skips instead — it may release the caller's own settled jobs,
and it may neither dispatch a stranger's build nor wait for one.

**Measured after the repair**, on the two seeds with the most to say:

| Seed | Before the repair | After |
| --- | --- | --- |
| **1** | 1 failed (`outbox-dispatch`, `periodic`) | `135 files, 1414 passed | 14 skipped`, **EXIT=0** |
| **42** | **4 failed** (`outbox-dispatch`, both `crash-restart` block-B arms, `periodic`, `sbx`) | `135 files, 1414 passed | 14 skipped`, **EXIT=0** |

**NR-15 stays OPEN.** Ruling (3)'s retirement condition is "zero reproductions across
M4-005's runs"; this run produced six. The dominant cause is repaired and the repair is
verified against two previously failing seeds — including the one carrying the most
failures — but four seeds are unverified and a full clean pass of the gate is the next
session's first measurement, not a claim this one may make.

**The residual, named rather than narrated.** Seeds 424242 and 20260803 also carried:

```
FAIL |api| test/solver/e2-objective.test.ts >
  S-08t under E2 objectives — bit-identical on a soft-rule-bearing class >
  reproduces B-fairness-shaped bit for bit under the FULL pinned set
```

Seed 42 carried the same class and **clears after the repair**, which makes machine load
during a stalled 45-second drain the likelier reading than an order dependence in the
solver — a 45-second wait in three files, three times over, is exactly the kind of load
that makes a wall-clock-sensitive reproducibility arm miss. The same file is the subject
of the red-case arm that failed GREEN in §14c, which is consistent with that reading.

**It is still NOT diagnosed and nothing is claimed about it.** Seeds 424242 and 20260803
have not been re-run since the repair, so the honest statement is that two of the six
failing seeds are verified clear, four are unverified, and the captures
(`.evidence-scratch/fixture-regression/seed-*.txt`) are what the next session reads
first.

### 14c. The three red-case arms that were not proven

The first complete 63-arm run. `60 proven, 3 not proven`, and none of the three is a gate
that stopped failing on its violation — every RED arm in the battery failed as required.

| Arm | Reading | Disposition |
| --- | --- | --- |
| `raw-nul-magic-bytes` | **INVERTED POLARITY, and the runner cannot score it.** The arm's own design (§5b) is that with the magic-byte sniff the misnamed fixture IS scanned and the gate FAILS, and with the sniff reverted it PASSES — the mutation control is the proof. The runner scores GREEN-must-pass, so this arm reports NOT PROVEN on every run and `pnpm red-cases` can never exit 0 | **Defect in this packet's own work**, found only by the complete run. The arm proves what it claims (transcript 06 shows both directions); it must either be scored by its own polarity or moved out of the pass/fail table. NOT repaired here — the repair is a runner change and the battery would have to be re-run |
| `red-case-runner-errored-signatures` | **ERRORED — "vitest matched no test file (a filter or a path is wrong)"** | The ERRORED detection this packet added (§4e) catching this packet's own arm, which is the control working. The arm passes standalone (transcript 06); wired into the runner its command does not resolve. NOT repaired here, same reason |
| `solver-progressive-pin-unfixed` | **GREEN FAILED** — the gate did not pass on a clean tree. Its green command is `vitest run apps/api/test/solver/e2-objective.test.ts`, the same file as §14b's residual | Most likely the same order-or-load sensitivity, not a defect in the gate. **Not asserted** — undiagnosed, and named |

The honest summary: **`pnpm red-cases` is RED on this tree, for three reasons, two of
which are scoring defects in arms this packet added and one of which is undiagnosed.** It
is reported rather than smoothed, because a battery that only ever appears green is the
thing this repository does not do.

> **Amended 2026-08-21 (§20).** All three are now closed. The two scoring defects were
> repaired in §16c. The third — `solver-progressive-pin-unfixed`, recorded above as "Most
> likely the same order-or-load sensitivity … **Not asserted** — undiagnosed, and named" —
> was neither order nor load: it was the S-08t/E2 arm in the file its green command runs,
> which was **never deterministic**, because a 10-second wall clock was pre-empting the
> deterministic budget pinned beside it (§20a). The "most likely" reading was wrong in its
> mechanism and right to refuse to assert itself. `corepack pnpm red-cases` on the repaired
> tree returns **63 case(s): 63 proven, 0 not proven**, exit 0 — transcript
> `30-red-cases-63-final-repaired.txt`, and §20e. *(The battery is 64 arms since FAD-50
> C-1 added `result-reproducibility-derivation-removed`'s sibling; §22.)*

---

## 16. After FAD-48 — what this session did, and what remains

FAD-48 arrived after §§0-15 were written. The branch was rebased onto `64a6ad2` and the
ruling's cheap, fully-verifiable items were completed; **clause (A)'s build was not
started**, and the continuation below is precise rather than a search.

### 16a. DONE — item (6), the research validator: a WORKTREE artifact, exactly as ruled

Re-run from the repository root of this worktree:

```
cd /…/.worktrees/m4-005 && bash schedulepoint-research/validate.sh
  ->  8 MISSING DIR lines, FAIL
```

And the diagnosis, which is not a cwd problem but a checkout one:

```
ls /…/SchedulePoint/schedulepoint-research/screenshots        -> admin errors navigation picklist requests …
ls /…/SchedulePoint/schedulepoint-research/reports/inbox      -> present
git ls-files schedulepoint-research | grep -c screenshot      -> 0
```

**The eight directories exist in the main working copy, are UNTRACKED, and are empty —
and git cannot track an empty directory at all.** A `git worktree` materialises tracked
content only, so they are absent here and would be absent in any fresh clone. The
validator therefore passes on main for a reason that does not survive a checkout.
Nothing was touched: `schedulepoint-research/**` and `validate.sh` are prohibited to this
packet, and the honest record is that this is **not a corpus defect and not a packet
regression** — it is an expectation the repository cannot satisfy for a fresh checkout,
and it belongs to whoever owns the corpus.

### 16b. DONE — item (7), `EV-M2-SBX/scenario-report.txt` refreshed to nine

Granted by FAD-48(7). `SP_EVIDENCE_REFRESH=1 corepack pnpm sbx`, EXIT 0:

```
scenarios required 9 · executed 9 · passed 9 · failed 0 · blocked 0 · vacuous 0 ·
probe-error 0 · not-runnable 0
  … SBX-015 — Execution, the infeasible-vs-failed distinction, regeneration, …
  … SBX-016 — Conflict detection — 100% of injected hard violations detected …
  … SBX-017 — Progressive builds — protected assignments preserved exactly, …
```

The same run rewrites six per-scenario artifacts in ACCEPTED bundles, which FAD-48 did
**not** grant; those were reverted and only `scenario-report.txt` and the three
`EV-M4-005/sbx-01{5,6,7}` artifacts are kept. §8 item 7's disclosure is now discharged
for the report and stands for the six.

### 16c. DONE — item (5) in part: the two scoring defects, DIAGNOSED and REPAIRED

Both were mine, both were invisible until the battery ran complete, and both had a
specific cause rather than a general flakiness.

**`raw-nul-magic-bytes` — the fixture never existed on the GREEN side.** The arm writes
its misnamed `.png` in `prepare`, and `prepare` runs *after* the violation is applied,
i.e. only on the RED side. Its GREEN run therefore scanned an empty directory —
`0 text file(s) scanned` in the retained transcript — and passed for the most boring
possible reason. Being an `invertPolarity` arm that REQUIRES GREEN to fail, it scored
NOT PROVEN on every complete run. Repaired with a `setup` phase that runs before the
GREEN command, and the distinction between `setup` and `prepare` is now written down.

Verified directly:

```
node scripts/red-cases/raw-nul-magic/write-misnamed.mjs
node scripts/gates/raw-nul-scan.mjs --dir scripts/red-cases/raw-nul-magic/fixture
  ->  FAIL … 1 raw U+0000 byte(s) at offset 30      exit 1   (GREEN must fail: it does)
```

**`red-case-runner-errored-signatures` — the detector detected its own control.** The
arm's RED output QUOTES the signature strings it is asserting about ("NOT detected as
ERRORED, and it must be: `No test files found…`"), and the runner scans an arm's output
for exactly those patterns. Self-reference, not a broken arm. Exempted explicitly
(`erroredExempt: true`) with the reason stated, rather than by weakening a pattern every
other arm depends on. `check.mjs` passes GREEN: `2 detected, 3 correctly left alone`.

**`solver-progressive-pin-unfixed` is NOT touched**, per FAD-48(5)'s "diagnosed first".
Its GREEN command is `vitest run apps/api/test/solver/e2-objective.test.ts` — the same
file as §14b's residual — and seed 42 carrying that same failure cleared after the drain
repair. The likeliest reading remains machine load during three stalled 45-second drains,
which the repair removes; it is **unverified**, and verifying it is one re-run.

### 16d. NOT DONE — and exactly what remains

| # | Item | State |
| --- | --- | --- |
| 1 | **Clause (A): the endpoint, the client sender, the real-stack e2e** | **NOT STARTED.** FAD-48's grant is unambiguous and scoped; nothing about it was begun |
| 2 | **NR-15: verify seeds 7, 424242, 20260803, 31337 + the rotating seed** | **NOT DONE.** Seeds 1 and 42 verified clear after the repair (§14b); the full gate has not been re-run |
| 3 | **Re-run the FULL 63-arm `red-cases` on the final tree** | **NOT DONE.** `run.mjs` has no arm filter, so the two repairs above are verified at the command level and not yet through the runner |
| 4 | **`solver-progressive-pin-unfixed`** | diagnosed as a hypothesis only; one re-run decides it |
| 5 | **The final battery on the final tree, and this INDEX's completion from it** | **NOT DONE** |

The order is FAD-48's own: build (A) first, then run everything once on the finished
tree. Running the batteries before (A) lands would produce a record that (A) invalidates.

---

---

## 17. (A) BUILT — the browser↔server join, and the critical path against the real stack

FAD-48 ruled the §12 escalation: **the join is BUILT, not waived, and a mocked critical
path is REFUSED.** This section is what that produced. It supersedes §12's "not
delivered" as a STATUS; §12's *measurement* stands unchanged and is why this exists.

### 17a. The obstacle, removed

§12 measured three things. Each has an answer now, and each answer is a measurement
rather than a claim:

| §12's measurement | Now |
| --- | --- |
| `apps/web/src/api/client.ts` sends no `X-SchedulePoint-Context` | it sends one on every capability request — `apps/web/src/api/context.ts` is the sender |
| **no response anywhere returns the counters** a client would need | `GET /organizations/:organizationId/me/context` returns them, with the caller's memberships |
| every e2e spec intercepts; the join has never run | `apps/web/e2e/critical-path.spec.ts` runs it, both viewports, with `page.route` nowhere in the file |

The single line that says the obstacle is gone, from transcript
`19-critical-path-real-stack.txt`:

```
STEP 0 join: GET .../api/organizations/…/groups/…/schedule/periods -> 200
  with declaration {"contextVersion":{"organizationVersion":4,"groupVersion":4,
                    "membershipSetVersion":8},"sessionEpoch":2}
```

A request the shipped bundle could not make three commits earlier, answered `200` by a
real server reading a real PostgreSQL row.

### 17b. `GET /me/context` — the endpoint, and the four things it refuses

`apps/api/src/http/routes/me-context.route.ts`, one new route file, exactly the file
FAD-48's allowed-file extension names.

* **`preauth` / `session-any`, no capability key.** Reading one's own context is session
  authority, not a permission — it returns the counters the §2.3 sequence is about to
  check against this very session, and a caller who cannot read them cannot make one
  authorized request. That is the **FAD-25 self-scoped precedent** applied to the
  declaration itself. I-02 is untouched: this is a declared policy in the existing
  pre-auth class, and a route with no policy still fails
  `scripts/gates/route-policy-check.mjs` (113 registered routes, PASS).
* **I-19** — the counters and the membership rows are read in **one unit of work**, so
  the declaration returned was simultaneously true. Two units of work would hand a
  client a declaration that never existed and a `409` it could not learn its way out of.
* **Organization-scoped context, deliberately.** `memberships_organization_read` (EX-2,
  migration 0001) is the only policy under which one read can enumerate the caller's
  GROUP memberships. RLS confines the rows to the organization AND the predicate
  confines them to `session.userId`; the response body is the only place in the codebase
  where an EX-2 read reaches a caller, so it carries both.

Four refusals, each proven in `apps/api/test/http/me-context.test.ts` (7/7 PASS against
real PostgreSQL), and asserted BEFORE the first success:

| Refusal | Result |
| --- | --- |
| no session | `401 UNAUTHENTICATED`, and the body contains neither `organizationVersion` nor `membershipId` |
| a session that has NOT satisfied its challenge | `401` — enforced in the handler, because the stage vocabulary has nothing fuller than `session-any` and `policy.ts` is not this packet's file |
| a session issued for ANOTHER organization (the same secret re-labelled) | refused |
| **another user's memberships** | unreachable — no user parameter exists. Probed with two users in one organization, each response checked against ground truth in BOTH directions |

And two tests that prove the response is not merely correct but **sufficient**: the
declaration built from it is accepted by a real capability route, and a declaration one
counter behind is `409 CONTEXT_STALE` with `recover: 'refetch-context'`, which one
re-read and one retry clears.

### 17c. The client sender, and a pre-existing defect it found

`apps/web/src/api/context.ts` + `apps/web/src/api/client.ts`:

* read **once per (session, organization)**, promise-cached so two components mounting
  together produce ONE read (I-10); a FAILED read is not cached, because caching it would
  turn one transient failure into a page that cannot recover without a reload;
* the counter selection **mirrors `packages/domain/src/context/verification.ts` exactly** —
  `groupVersion` for a group path, `null` for an organization path;
* `409 CONTEXT_STALE` → forget, re-read, replay **ONCE**. `SESSION_STALE` is not retried:
  its directive is `reauthenticate`, and replaying it would paper over the event the
  epoch exists to surface;
* the pre-auth surface and `/health` declare nothing and trigger no read — a sign-in that
  depended on being signed in would be a bootstrap deadlock.

**A PRE-EXISTING DEFECT, found by building the sender.** `errorEnvelopeSchema` is
`.strict()` and knows three fields; SPEC-01 §2.3's recoverable bodies carry a fourth
(`recover`), so `contextStaleBodySchema` is a wider shape. Every `409 CONTEXT_STALE` and
`409 SESSION_STALE` the server has ever sent would therefore have failed the strict parse
in `client.ts` and reached the caller as `UNEXPECTED_RESPONSE` **with the code erased**.
Nothing noticed, because no browser request had ever got far enough to be told its
context was stale. `client.ts` now tries both shapes; `packages/contracts` is not
loosened and is not this packet's file.

Proven in `apps/web/test/context-declaration.test.ts` (9 tests): the wire form at both
scopes, ONE context read for three concurrent requests, exactly one retry, a second stale
answer surfaced rather than retried, `SESSION_STALE` not retried, and a failed context
read rejecting rather than silently sending no declaration.

### 17d. The critical path — what ran, and what it is honest about

`apps/web/e2e/critical-path.spec.ts`, driven by `apps/web/e2e/real-stack.config.ts`.

| Layer | What actually runs |
| --- | --- |
| browser | Chromium, the PRODUCTION `apps/web/dist` bundle, desktop 1280×800 and mobile 390×844 |
| origin | a static+proxy server — ONE origin, as the ingress image gives a deployment |
| API | `apps/api/src/index.ts`, the process a deployment runs, with its outbox runner and its `build.solve` queue runner |
| database | a throwaway PostgreSQL cluster, migrated (19), RLS on, seeded through the production write path |
| solver | REAL CP-SAT, `SP_SOLVER_WORKER_COMMAND` (never committed) |

`page.route` appears nowhere in the file and no response is fabricated. The harness is
spawned as a PROCESS, never imported: `apps/web` may import `packages/contracts` and
nothing else, and an e2e harness is not exempt from the boundary it exists to test
across. Three ports are DERIVED per worktree, in bands that cannot collide with the
Vitest cluster — E-1's lesson applied a third time.

The steps, as the transcript records them:

| Step | Where it ran | Measured |
| --- | --- | --- |
| 0 join | browser | `GET …/schedule/periods -> 200` carrying the declaration |
| 1 period | browser | a period created in PostgreSQL, id assigned by the server |
| 2 demand | browser | a dated requirement saved |
| **3 profiles / qualifications** | **API — no browser surface exists** | real HTTP, same session, same declaration |
| 4 rules | browser | the rules surface rendered from the real server |
| **5 canonical input** | **API — no browser surface exists** | observed through the build |
| 5′ draft version | browser | a draft version created |
| 6 build | browser | configuration created, build launched |
| 7 worker | REAL worker + REAL CP-SAT | `draft_configuration -> validating -> completed` |
| 8-9 validation / quality | browser | "The independent check accepted this candidate. Zero hard violations." + the quality panel |
| 10-11 selection into a new draft | browser | `completed -> reviewed -> approved -> select` (1 request) |
| 12-13 publication | browser | review, version history, published schedule |
| 14 staff view | browser | my-schedule |

**axe-core: ZERO violations at every captured surface, both viewports.** Twenty-four
screenshots in `screenshots/critical-path-*`.

**I-13 on the real stack, for the first time:** "New period" 0 requests, "New
configuration" 0 requests. Under interception those reads resolve instantly and the
question never arises; against a real server an I-13 recording has to wait for the
page-load reads to settle first, or a request nobody caused is counted against the click.

**The request ledger** (`critical-path-requests.{desktop,mobile}.json`, identical at both
viewports): open new period **0** · save period **2** · save requirement **2** · create
draft version **2** · open new configuration **0** · save configuration **2** · launch
build **2** · select candidate **1**.

### 17e. What clause (A) does NOT claim

Stated at the same prominence as what it does.

1. **Two of the fourteen steps have no browser surface in M4.** `router.tsx` has no
   work-profile/qualification page and no canonical-input page; CAP-020's remaining views
   are M6 and doc 35 §6g's own Excluded row says so. They are driven over **real HTTP
   against the same real API**, with the same session and the same declaration — not
   mocked, and labelled as the smaller claim they are wherever they appear.
2. **The selection step answered with no visible outcome element.** The write happened
   (one request, and `Select this candidate` is only offered in `approved`), but neither
   `build-applied` nor `build-source-moved` was found afterwards. Reported, not explained.
3. **The suite SKIPS under the default Playwright config**, where there is no stack. That
   is the spec declaring its precondition, not a weakened test.
4. **One tenant, one scheduler, one week per viewport.** This is a workflow proof, not a
   load or concurrency proof — the matrix (§3) is where concurrency lives.

### 17f. Four conditions the real stack surfaced that no mocked run could

Each cost a measured failure before it was understood, and each is a property of the
system rather than of the test:

1. `staffing: true` and `scheduleCredentials: true` cannot be seeded together — `23P01`
   on `capability_grants_no_overlapping_window`, the exclusion constraint doing its job.
   No file in the suite combines them either.
2. **`SP_SOLVER_RPC_SECRET` has no default and must not get one** (SPEC-04 §1.1, mutual
   authentication). The first real solve reached `running` and failed on exactly that
   refusal.
3. **One MFA key must span the provisioning process and the API process.**
   `createSecretBox()` mints a random key when none is set — a correct fail-safe that
   makes a challenge impossible across two processes, with an error that says only "no
   enrolment".
4. **A build does not start solving because a row exists.** M4-003's sixteen-state
   machine requires the scheduler's own `Submit for validation`, and then `I have
   reviewed the findings` and `Approve` before a candidate can be selected. The spec
   drives those acts; it does not skip them.

---
---

## 18. NR-15 on the finished tree — the residual, DIAGNOSED and repaired at the seam

`corepack pnpm fixture-regression` under the widened capture, the full seed set, on the
tree that carries clause (A). Transcript `22-fixture-regression-nr15.txt`; every failing
seed's complete output retained under `.evidence-scratch/fixture-regression/`.

| Seed | Result |
| --- | --- |
| 1 | **FAIL** — 2 failed \| 1419 passed |
| 7 | **FAIL** — 2 failed \| 1419 passed |
| 42 | PASS — 1421 passed |
| 424242 | **FAIL** — 2 failed \| 1419 passed |
| 20260803 | PASS — 1421 passed |
| 31337 | **FAIL** — 1 failed suite |
| 99991 | **FAIL** — 2 failed \| 1419 passed |
| 123456 | **FAIL** — 2 failed \| 1419 passed |
| 20250101 | PASS — 1421 passed |
| 8675309 | **FAIL — CONTAMINATED, see below** — 435 passed \| **1000 skipped** |
| 65339 | PASS — 1421 passed |
| 531651 | PASS — 1421 passed |
| 740673 | PASS — 1421 passed |
| **rotating 301607** | **PASS** — 1421 passed |

`EXIT=1`. Six of thirteen seeds failed; the rotating seed drawn for this run PASSED.

> **Seed 8675309 is NOT evidence and is disclosed as such.** `435 passed | 1000 skipped`
> is the CONTENTION signature the runbook documents, not a fixture-isolation failure — and
> the cause was mine: I ran `npx vitest` against the two repaired files while this gate was
> still running, and the second run took the same derived cluster port. That is E-1
> reproduced by hand, in the packet that quotes E-1 three times. It is recorded rather than
> quietly dropped, and it means the honest count of MEANINGFUL failures is **five of
> twelve**, all of them the residual below.

**NR-15 REPRODUCES. It is NOT retired, and it is not "intermittent" either — it is now
fully diagnosed.** Two files fail and only two, always the same two, and the capture gives
the cause in one line:

```
FAIL |api| test/audit/outbox-dispatch.test.ts
AssertionError: this file must leave the queue empty — every job it enqueued is
                finalized: expected 23 to be +0
```

**Twenty-three** leftover jobs on seed 31337, none of them that file's.

### 18a. The residual is the previous repair, applied to only half the seam

§14b repaired `drainQueue`: **a drain waits on the jobs it registered a handler for, and
only those**, because a handler-less `build.solve` job made the loop unsatisfiable — a
deadlock by construction. That repair is correct and it holds.

**The assertion that follows the drain was not repaired with it.** Three places counted
every row in `graphile_worker._private_jobs`:

| Where | What it was |
| --- | --- |
| `apps/api/test/audit/outbox-dispatch.test.ts` — local `queuedJobs()` | `count(*) from graphile_worker._private_jobs` |
| `apps/api/test/audit/crash-restart.test.ts` — local `queuedJobCount()` | the same query, copied |
| `apps/api/test/support/queue.ts` — exported `queuedJobCount` | the same query, and the honest one |

So under a shuffled file order the drain **correctly ignored** a foreign `build.solve` job
and the assertion **correctly counted** it, and the file failed. Both halves were doing
exactly what they were written to do; they were written to different questions.

### 18b. The repair

**A drain and the assertion that it worked must use the same predicate.** The two local
copies now call `drainableJobCount` — the one definition, in `support/queue.ts`, whose
namespace test (`outbox.%` / `audit.%`) means a task added inside the namespace joins the
count automatically and a task added outside it is correctly ignored. That property is why
§14b chose a namespace rather than an exclusion list, and it is why this repair needs no
list either.

`queuedJobCount` in `support/queue.ts` still counts EVERYTHING and is deliberately left
alone: "how many jobs exist" is a real question, it is just not the question a drain's
postcondition asks.

**The precondition is not weakened.** `crash-restart`'s block B needs the queue empty so
its worker leases the job IT published — and that worker registers `outbox.dispatch`
alone, so a `build.solve` job could never have been leased by it. Counting only what the
drainer can consume makes the precondition satisfiable without making it weaker. That is
the same argument §14b made, and it is the same argument because it is the same seam.

### 18c. What is proven about the repair, and what is NOT

**Proven:** the diagnosis, from the retained captures — five of the twelve uncontaminated
seeds fail, always in the same two files, always on the same assertion, with foreign job
counts (2, and 23) that no `outbox.*`/`audit.*` backlog explains. `lint` 0 and `typecheck` 0 after the repair.

**NOT proven, and stated plainly: the repair has not been verified by a re-run of the
gate.** A `fixture-regression` pass is ~45 minutes and this session did not have one after
the repair landed. The attempt to verify the two files directly is what contaminated seed
8675309 above — the E-1 lesson, paid again, and recorded rather than hidden.

**NR-15 therefore stays OPEN, and its disposition is now `DIAGNOSED, REPAIRED,
VERIFICATION PENDING` rather than `unresolved intermittent`.** The next session's FIRST
measurement is one command:

```
SP_SOLVER_WORKER_COMMAND=… corepack pnpm fixture-regression
```

Ruling (3)'s retirement condition is "zero reproductions"; this run produced five meaningful ones, so
nothing is retired here. What has changed since §14b is that there is no longer anything
unexplained: the cause is named, the repair is at the shared resource, and the verification
is a single command rather than a search.

### 18d. What was NOT run on the finished tree

Stated at the same prominence as what was:

* **`corepack pnpm red-cases` (63 arms — 64 since FAD-50) was NOT re-run after clause (A) landed.** §16c
  repaired the two scoring defects and verified them at the command level; the runner-level
  re-run is still outstanding, and so is the `solver-progressive-pin-unfixed` verdict —
  which §16c's reading (machine load during the stalled 45-second drains) predicts should
  clear once the drain no longer stalls, and which is therefore worth re-measuring AFTER
  §18b rather than before.
* **`fixture-regression` after the §18b repair** — see §18c.

Both are the continuation, and both are one command each.

> **CLOSED 2026-08-21 (§20e).** Both ran on the repaired tree, serially, on an idle
> machine, the first result read and validated before the second was launched.
>
> * `corepack pnpm red-cases` — **63 of 63 proven, 0 not proven**, exit 0. Transcript
>   `30-red-cases-63-final-repaired.txt`. The `solver-progressive-pin-unfixed` verdict this
>   section held open is in: PROVEN, and diagnosed rather than predicted (§20a/§20b).
> * `corepack pnpm fixture-regression` — transcript `31-fixture-regression-final.txt`; the
>   result is in §20e row 7.
>
> The prediction recorded above — that the arm "should clear once the drain no longer
> stalls" — did not hold as stated: the drain repair (§18b) is sound and independent, and
> the arm was failing for a different reason entirely. Recorded rather than quietly
> superseded.

---

## 19. Current-state summary — what M4 proved, and what it did not

Written for doc 36 to lift. Every line is a statement about evidence in this repository.

### 19a. What M4 proved

* **The 14-step workflow runs end to end through a real browser against a real server**
  (§17): real Chromium on the production bundle, one origin, `apps/api/src/index.ts`, a
  migrated PostgreSQL cluster with RLS on, the real queue runner and real CP-SAT. Both
  viewports, axe green, every interaction's request count recorded.
* **SPEC-01 §2.2's declare/verify contract now has both halves.** The client declares and
  the server verifies; a stale declaration is `409 CONTEXT_STALE` and one re-read and one
  retry clears it.
* **The concurrency-and-recovery matrix** — 40 named proofs, every row, DB-asserted (§3).
* **SBX-015/016/017** — 9 of 9 scenarios, 22 of 22 injected hard violations detected AND
  explained, **0 vacuous** (§11).
* **D-4b and the queue binding** — migration 0019, the `build.solve` task, the claim-time
  per-organization cap, S-16t (§2).
* **The gates hold on the finished tree** — `check`: 17 of 17, unit 2109 passed, axe 428
  passed at both viewports. Migration cycle 0001–0019 clean in both directions, twice.

### 19b. What M4 did NOT prove

* **Benchmark bands** — M6. Nothing here measures solver performance against a band.
* **Two of the fourteen critical-path steps in a browser** — work profiles/qualifications
  and the canonical input have no page in M4 (CAP-020's remaining views are M6). They are
  proven over real HTTP and labelled as the smaller claim (§17e).
* **NR-15's repair** — diagnosed and repaired, verification pending (§18c).
  **Amended 2026-08-21:** verified. The NR-15 C-2 drain seam is clean across the full seed
  set (transcript 24), and the two seeds that failed that run failed for an unrelated
  cause now diagnosed and repaired (§20).
* **The 63-arm red-case battery on the finished tree** (§18d). *(64 arms since FAD-50 C-1's
  new arm; see §22.)*
  **Amended 2026-08-21:** run, and **63 of 63 proven, 0 not proven** (§20e, transcript 30).
* ~~**That a solve claiming reproducibility can actually be reproduced.** … Escalated, not
  repaired — the two files involved are prohibited to this packet (§20d).~~
  **AMENDED 2026-08-21 (C-6): this line is now FALSE and is struck rather than deleted.**
  The escalation was ruled (FAD-49) and BUILT in §21: the result-side verdict is derived
  from facts already persisted, and every surface that reports a result consumes it.
  FAD-50 B-1 then closed the hole §21 left — a CANCELLED run still rendered
  `reproducible` — by reading the termination fact too (§22a). What M4 does NOT prove
  here is narrower and is stated in its place: **that a build reported `reproducible` was
  re-run and produced the same schedule.** The verdict is a claim the record can now
  support; no arm re-runs a persisted historical build end to end and compares. S-08t
  proves bit-identity for a solve performed twice in one test, which is the same property
  over a shorter interval.
* **M3R is PAUSED** and nothing in this packet changes that.

### 19c. CI conditions, unchanged and still open

* **The solver image digest is not pinned**, and the CP-SAT worker is reached through
  `SP_SOLVER_WORKER_COMMAND`, which is a machine-local path this repository must never
  contain.
* **The Python 3.12 rerun** has not been performed; every solve recorded here ran under
  the one interpreter the reference machine has.
* ~~**The research corpus's validator cannot pass from a fresh checkout.**~~
  **CLOSED 2026-08-21 (C-6).** Fixed on `main` at `b370e03`: eight tracked `.gitkeep`
  placeholders materialise the required-but-empty directories git cannot otherwise carry,
  `validate.sh` unmodified and no research claim touched, with the failure reproduced and
  the pass proven from clean clones. Struck rather than deleted, because §16a's diagnosis
  is what the fix was built from.
* **No key is isolated.** The audit checkpoint signer and the MFA secret box both run as
  local stubs and say so at startup, every time. SPEC-11 §6 requires a separate trust
  domain; that is a deployment condition (TDG-15).

### 19d. The sentence that is not in here

**No production-readiness claim and no compliance claim of any kind** — not HIPAA, not
PHIPA, not SOC 2, not ISO 27001, not GDPR. The required legal and operational work is
explicitly not done, and nothing in this bundle should be read as progress toward saying
otherwise.

## 20. The two open findings, DIAGNOSED and repaired — and the one cause behind both

Added 2026-08-21 by the OPUS-M4-005 continuation. §§0-19 are unchanged; this section
closes the two findings transcripts 23 and 24 left open, completes §18d, and records what
it escalates. Transcripts `25`-`31`.

Both findings have **the same single cause**, and it is not the one either was filed
under. The short version:

> `DETERMINISTIC_PARAMETERS` pinned a deterministic budget **and a 10-second wall clock**.
> CP-SAT stops at whichever arrives first, and on `B-fairness-shaped` the wall clock
> arrived first every time — so the pinned deterministic budget never got to be the thing
> that ended the search, and the run was reproducible only by luck. It held roughly two
> times in three.

### 20a. Finding 1 — S-08t/E2 was never deterministic, and the failure is not load-related

The premise this continuation inherited was that the arm "PASSES standalone" and fails
only under a shuffled full suite. **That premise is false**, and disproving it was the
first measurement: three standalone single-file runs on an idle machine, serially, gave
**two passes and one failure** (transcript 25 part A). No sibling test was in the process.
Order dependence, port residue and cross-file state contamination are ruled out by that
run alone, not by argument.

The second fact was in the durations: the arm took ~20.5s **whether it passed or failed**,
against a pinned `maxTimeInSeconds: 10`. Two solves, each running the wall clock out,
every time.

A temporary diagnostic (since removed) then dumped the complete recorded reproducibility
material of both solves — canonical input digest, objective profile and digest, seed,
worker count, interleave setting, deterministic-time limit, status, objective value and
tiers, the full statistics record, the runtime record, and the assignments — under the
shipped pinned set and under a raised wall clock, on a calm machine and under ten
deliberate CPU hogs in a **separate throwaway worktree** (transcript 25 parts B and C):

| condition | wall | deterministic units | branches | status | bound reached |
| --- | --- | --- | --- | --- | --- |
| wall 10, calm | 9.497948 / 9.491109 | **21.760483 / 21.660444** | 62256 | FEASIBLE | no |
| wall 10, loaded | 10.003466 / 9.969748 | **12.532388 / 12.444773** | 41091 | FEASIBLE | no |
| wall 900, calm | 32.618628 | **76.702882 / 76.702882** | 137137 | OPTIMAL | yes |
| wall 900, loaded | 56.664773 / 56.703392 | **76.702882 / 76.702882** | 137137 | OPTIMAL | yes |

`deterministicTimeUnits` is SPEC-04 §4's machine-INDEPENDENT measure of how much search a
run did, and it is the number that discriminates:

* With the wall clock binding it **moves between two solves in one process** — 21.760483
  against 21.660444 — and moves again with the machine's load. Different search, therefore
  a different candidate, at the identical objective value 4120000 every time. That is the
  assertion at `e2-objective.test.ts:257`.
* With the wall clock out of the way it is `76.702882` in **every** run, on a calm machine
  and on one running 1.7× slower alike, with identical `branches` and `conflicts` and a
  byte-identical candidate. This is what discriminates the cause from "the model is just
  symmetric": a symmetric model would still be free to return either optimum, and it
  returns exactly one, reproducibly, the moment the stopping point stops depending on a
  clock.
* The budget was never close to spent — 12 to 22 units consumed against the 100 pinned —
  so the deterministic limit demonstrably was not what stopped the search.

The canonical input digest is
`492e4d98422a9e2a8f5f6f554de3528196c20c2348542a49316708cb353732b0` for both solves in
every configuration, and the worker echoes it back, so seed-or-ordering dependence in the
fixture feeding the solver (hypothesis (d)) is ruled out by measurement. Every pinned
field is identical across both solves, so incomplete pinning (hypothesis (a)) is ruled out
the same way. The cause is (b), and specifically: **a genuine deterministic budget was
being pre-empted by a wall clock nobody intended as a budget.**

### 20b. Finding 2 — both red-case GREEN arms are collateral, and nothing else

No new run was needed. Transcript 23 records only pass/fail per arm; the 63-arm battery's
**full per-arm output was retained** at `.evidence-scratch/scripts/red-cases/evidence-output.txt`
(3.9 MB), and it names the failing test in each case (transcript 26).

| Arm | GREEN command | What failed in GREEN |
| --- | --- | --- |
| `stale-edit-cas` | `run gate:unit` — the whole unit suite | **Exactly one test of 2123**: the S-08t/E2 arm, 20928ms, same `Object.is` assertion |
| `solver-t2-false-minimality` | `vitest run e2-objective.test.ts corpus-agreement.test.ts` | **Exactly one test of 35**: the same S-08t/E2 arm, 20882ms, same assertion |
| `solver-progressive-pin-unfixed` | `vitest run e2-objective.test.ts` | **nothing — GREEN passed**, S-08t 20522ms |

Both RED halves failed for their own intended reasons: `stale-edit-cas` on its four
concurrency proofs (B-1, B-2, B-3, the 12-round whole-set race), and
`solver-t2-false-minimality` on the T2 narrowing proof and the corpus
"EXPLAINED_MINIMAL is EARNED" proof, both `expected 0 to be greater than 0` — the
iterations counter its patch pins at zero. **Neither gate stopped biting.**

The third row is the discriminator. Three arms, one shared failing test, two failures and
one pass in a single battery: that is a ~1-in-3 nondeterministic test, not a defect in two
particular arms — and §20a then measured that rate directly. Contention, residual state,
port or database collision and cleanup failure are all ruled out by the same fact that
rules them out for Finding 1: the test fails in a single-file run with no runner involved.

**No repair is due to either arm.** The prediction that both return to PROVEN once §20c
lands was tested, not asserted — §20e.

### 20c. The repair — the wall clock stops being a budget, and the test says so

Three files, all under `apps/api/test/**` (doc 35 §6g, "Allowed files"). No product code
was touched, and nothing was weakened, skipped, widened, retried or marked flaky.

**1. `apps/api/test/support/solver.ts` — `maxTimeInSeconds: 10` → `900`.**
SPEC-04 §4 as amended is explicit that the reproducibility basis is
`max_deterministic_time`, **never a wall clock**. The constant pinned both and the worker
sets both, so the wall clock was racing the budget it was supposed to be subordinate to.
900 is a **safety net, not a budget**: `maxDeterministicTime: 100` bounds the search on its
own at roughly 43 wall-seconds on this machine, so the net has better than a 20× margin
and cannot become the binding constraint through ordinary load. The deterministic budget's
VALUE is deliberately unchanged — the defect was never that 100 units is the wrong amount
of search, it was that a wall clock was allowed to end the search before the budget did.
The docblock carries the measurement table above, so the next reader does not have to
rediscover it.

**2. The S-08t/E2 arm ESTABLISHES its precondition** (`e2-objective.test.ts`). The identity
assertion is untouched. Added around it:

* both solves are asserted **not wall-clock-bound**, via a new `wallClockVerdict` helper —
  on a machine slow enough to make the 900-second net bind, the arm now fails and names
  why, which is the opposite of passing non-reproducibly;
* `deterministicTimeUnits`, `branches` and `conflicts` are asserted **equal between the two
  solves**. This is strictly stronger than the byte comparison: two solves can agree on a
  candidate by coincidence and cannot agree on the exact deterministic time consumed unless
  they performed the same search. It is also the number that actually moved.

**3. A non-vacuity control, in the same file.** `the precondition BITES: with the old 10s
wall clock the search is wall-bound` re-runs the same class with the one field restored and
asserts the verdict flips, that the deterministic budget is nowhere near spent, and that the
platform still reports `deterministic`. Without it the precondition check could be asserting
`false` against a condition nothing can satisfy, and the repair would be decoration. It is
deterministic — this class burns the full 10s in every run ever measured — and it costs 10s.

**4. The sibling S-08t proof gets the same condition** (`real-solve-lifecycle.test.ts`).
`B-feasible-small` proves optimality in well under a second and was never at risk, which is
exactly why the condition is asserted rather than inferred from the arm passing. Its
companion "every condition is REQUIRED" test gains the fifth condition it was missing:
`maxTimeInSeconds` must be at least 5× what the deterministic budget can spend.

### 20d. ESCALATED, not repaired — the outcome does not record which limit stopped the search

This is the product-side half of the same finding and it is **out of this packet's globs**.

`solver/schedulepoint_solver/cpsat_adapter.py` returns `TERMINATION_COMPLETED` for a
`FEASIBLE` result that a wall clock truncated; the honest record would distinguish "the
search ended" from "the clock ran out with an incumbent in hand". And
`reproducibilityMode` (`packages/domain/src/ports/solver-port.ts`) is computed from the
REQUEST — correctly, as the platform's statement about what it dispatched — so it reports
`deterministic` for every wall-clock-truncated run in §20a's table. Nothing in a persisted
build record would tell an operator that a build claiming reproducibility cannot be
reproduced.

Both files are expressly prohibited by doc 35 §6g. **Not touched.** The control arm in
§20c(3) pins the current behaviour as a tripwire: if that escalation lands, it fails and
must be updated deliberately rather than silently.

A related record-keeping point, for whoever takes the escalation:
`apps/api/test/solver/deterministic-cost.test.ts`'s docblock attributes
`B-fairness-shaped`'s `FEASIBLE`-vs-`OPTIMAL` split, and its 10.05× ratio, to "the
deterministic budget stopped the search before optimality was PROVEN". The measurement
above shows it was the **wall clock**, at 12-22 of 100 units. The observation is real; the
attribution is wrong, and it is in EV-M4-004's territory rather than this bundle's.

### 20e. What was re-run, and what it says

Every command below ran on the repaired tree, serially, on an otherwise idle machine, with
`SP_SOLVER_WORKER_COMMAND` pointed at the venv interpreter. Nothing was run concurrently
with anything else.

| # | What | Command | Result | Transcript |
| --- | --- | --- | --- | --- |
| 1 | the targeted test, standalone, ×3 | `vitest run --project api apps/api/test/solver/e2-objective.test.ts` | **3 pass / 0 fail**, `27 passed (27)` each, exit 0 (was 2 pass / 1 FAIL) | `27` |
| 2 | seed 123456, complete shuffled context | the gate's own per-seed command | **PASS** — `1422 passed \| 14 skipped`, exit 0 | `28` |
| 3 | seed 531651, complete shuffled context | the gate's own per-seed command | **PASS** — `1422 passed \| 14 skipped`, exit 0 | `28` |
| 4 | `stale-edit-cas` GREEN half, ×3 | `pnpm run gate:unit` | **3 pass**, `2110 passed \| 14 skipped`, exit 0 | `29` |
| 5 | `solver-t2-false-minimality` GREEN half, ×3 | its own two-file vitest command | **3 pass**, `36 passed (36)`, exit 0 | `29` |
| 6 | **the FULL red-case battery** | `corepack pnpm red-cases` | **63 case(s): 63 proven, 0 not proven**, exit 0 | `30` |
| 7 | **the FULL fixture-regression gate** | `corepack pnpm fixture-regression` | **151 run(s): 151 passed, 0 failed**, exit 0 | `31` |

Row 7 in full: all **thirteen** fixed seeds pass — including **123456 and 531651**, the two
that failed in transcript 24 — the rotating seed (this run drew **50063**) passes, and
every one of the 137 test files passes standalone. `Order-independent under every seed
tried. Every file also passes alone. The shared baseline was unmodified in every run.`
Both batteries ran on the same tree, one after the other, the first read and validated
before the second was launched: red-cases 04:15:34→06:20:35 UTC, fixture-regression
06:28:40→08:07:18 UTC.

Row 6 is worth stating separately: **this is the first time the 63-arm battery has come
back entirely green.** §14c recorded three not-proven arms on the first complete run and
§16c repaired two of them; the third — `solver-progressive-pin-unfixed`, recorded there as
"Most likely the same order-or-load sensitivity, not a defect in the gate. **Not
asserted** — undiagnosed, and named" — was the same S-08t nondeterminism, and that reading
is now diagnosed rather than guessed. Both arms of Finding 2 are PROVEN in the same run,
each with its GREEN half passing and its RED half still failing on its own violation.

### 20f. What the commit carries, and what it deliberately does not

One commit on `opus/m4-005-integration`, on top of `06c702e`. Three source files and eight
evidence files, and nothing else:

| Path | Why it is in glob |
| --- | --- |
| `apps/api/test/support/solver.ts` | `apps/api/test/**` |
| `apps/api/test/solver/e2-objective.test.ts` | `apps/api/test/**` |
| `apps/api/test/solver/real-solve-lifecycle.test.ts` | `apps/api/test/**` |
| `docs/evidence/EV-M4-005/INDEX.md` | `docs/evidence/EV-M4-005/**` |
| `docs/evidence/EV-M4-005/transcripts/25`…`31` | `docs/evidence/EV-M4-005/**` |

**Not committed, deliberately.** `scripts/check-output.txt` and
`scripts/red-cases/evidence-output.txt` are untouched — both batteries wrote to
`.evidence-scratch/` because neither was run with `--refresh` (NR-14), so the tracked
artifacts never moved. `.evidence-scratch/**` is untracked scratch and stays that way; the
two per-seed captures §20a reads (`seed-123456.txt`, `seed-531651.txt`) are cited from
there rather than copied into the bundle, because transcript 25 carries the extracted
material the diagnosis actually rests on. No `dist/` artifact survived either battery — the
runner's own sweep reported `swept 4 compiled red-case artifact(s) from dist/`, and
`git status` was clean of them before and after. No product code, no gate, no migration, no
document outside this bundle.

### 20g. The cost, stated plainly — and the knob that would recover it

The repair is not free, and pretending otherwise would be the kind of reporting this
bundle does not do. Six `B-fairness-shaped` solves in `e2-objective.test.ts` were being cut
off at 10 wall-seconds apiece; each now runs to a proven optimum at ~33s. Measured:

| | before | after |
| --- | --- | --- |
| `e2-objective.test.ts` alone | 68.9s | 225.6s |
| the whole `api` project, one shuffled seed | 206.9s | 384.3s |
| `gate:unit` (every project) | ~370s | 428-433s |
| `corepack pnpm red-cases`, 63 arms (64 since FAD-50) | 81 min | **125 min** |
| `corepack pnpm fixture-regression`, 151 runs | 55 min | **99 min** |

**The knob, named rather than turned.** The requirement the repair implements is that the
wall clock must not be the binding constraint. That is satisfied by any wall clock
comfortably above what the deterministic budget can spend — it says nothing about how large
the deterministic budget should be. Lowering `maxDeterministicTime` from 100 to roughly 20
would restore the old battery runtime **and** keep every reproducibility property intact,
because the search would then stop at a deterministic unit count rather than a clock. It
was deliberately NOT done here: that is a decision about how much search the corpus fixture
should buy, it would swap a proven-optimal answer for a budget-truncated one on this class,
and choosing it immediately after observing a failure is indistinguishable from tuning a
test until it is fast. It belongs to whoever owns the corpus budget, with this measurement
in front of them.

## 21. §20d's escalation, RULED and DISCHARGED — the result-side record made honest

Added 2026-08-21 by the OPUS-M4-005 continuation, under **FAD-49**. §20 stands unchanged;
this is the corrective round the ruling authorized, and it closes the one thing §20 could
diagnose and was not permitted to repair. Transcripts `32`–`33`.

### 21a. What §20d escalated, and what the ruling granted

§20 repaired the TEST fixture and left the PRODUCT gap named and untouched:
`reproducibilityMode` is computed from the request, `builds/service.ts` defaults
`max_time_seconds` to **10**, and a deterministic-mode build whose wall clock ran out
persisted `reproducibility_mode = 'deterministic'` — which the build detail screen rendered
as *"Deterministic — reproducible. The full pinned parameter set is in force, so the same
problem run again on the same worker build produces the same schedule."* Every word of that
is true of the CONFIGURATION and false of that RUN.

FAD-49 ruled the honest verdict **derived, not stored**: no schema change, no worker
change, `solver/**` still closed, `cpsat_adapter.py`'s `TERMINATION_COMPLETED` wording left
exactly as it is with the platform-side derivation carrying the honesty.

### 21b. The premise the ruling rests on, CHECKED rather than assumed

FAD-49(1) made a factual claim — that the facts needed are already persisted — and made it
falsifiable: *"if the implementer proves statistics insufficient, that is a new escalation,
not a grant."* It was checked before anything was written:

| Fact the verdict needs | Where it already lives | Written by |
| --- | --- | --- |
| the dispatched wall-clock budget | `build_runs.solver_parameters` (jsonb) | `runQueuedBuild` (`runner.ts`), at CLAIM time |
| the deterministic budget + portfolio flag | the same jsonb | the same statement |
| what the search actually spent | `build_run_results.quality_metrics.solverStatistics.wallTimeSeconds` | `persistOutcome`, read back by `qualityOf` |

**The statistics suffice. No escalation, no migration.** The parameters are written at claim
time precisely so *"a build that then crashes still says what it was run with"* — the
comment was already there, for a different reason, and it is what makes this derivation
possible.

**One limit, found by measurement and not smoothed over.** `solver_parameters` is written in
exactly ONE place: the real dispatch path. A test fixture that reaches a persisted result
through the lower-level `claimQueuedBuild` + `persistOutcome` pair produces a row shape
production cannot — `reproducibility_mode` set, `solver_parameters` empty. The derivation
**fails closed** on it (`unrecorded`, never a claim), and that is pinned as its own arm
rather than left to inference. The first version of that test asserted the parameters were
always present, failed, and was corrected to assert what is true — recorded here because the
tempting move was to adjust the assertion until it passed.

### 21c. What was built — ONE predicate, and every result surface consuming it

**The domain** (`packages/domain/src/ports/solver-port.ts`, additive + the doc correction
FAD-49(2) required). `reproducibilityMode` is unchanged in behaviour and re-documented as
what it is — **the dispatch statement**. Its docblock used to claim it "refuses to call a
RUN reproducible when they are not set", which §20a's measurement falsified for the result;
it now says so, and points at its other half. Beside it:

```
resultReproducibility({ parameters, wallTimeSeconds }) -> {
  verdict: 'reproducible' | 'wall-clock-truncated' | 'best-effort' | 'unrecorded',
  reproducible: boolean,
  detail: string,          // never empty; names the reason for a refusal
}
```

Four verdicts, exactly one of which sets `reproducible` (asserted). `WALL_CLOCK_BINDING_FRACTION`
is `0.9`, justified from §20a's four measured stops against a 10s budget — 9.497948,
9.491109, 9.969748, 10.003466, the lowest of them 94.9% — and all four are asserted to be
caught. **FAD-34's vocabulary is untouched:** this is a reproducibility statement, not a
termination reason. A wall-clock-truncated `FEASIBLE` is still `FEASIBLE`, still `completed`,
still a usable schedule; the only thing it cannot do is promise to happen again.

**No second spelling.** §20c's test-support `wallClockVerdict` now holds no logic — it
delegates to the domain function and reshapes the answer for the assertions that read it.
The threshold exists once. That is FAD-49(2)'s S-01 clause, and it is the reason this round
did not simply add a product predicate beside a fixture one that already worked.

**The API.** `runResultReproducibility` (`builds/service.ts`) lifts the two facts off the
row and defers to the domain; the detail route carries **both** — `reproducibility` (the
dispatch statement, unchanged) and `resultReproducibility` (the verdict). The contract
addition is additive; nothing existing changed shape.

**The screen.** `BuildDetailPage` renders the RESULT verdict, and renders the server's own
`detail` sentence verbatim rather than composing one, because the reason quotes that run's
measured search time and a client-side reason would be a second source for a fact the server
already has. `RESULT_REPRODUCIBILITY_LABELS` is separate from the configuration labels on
purpose: the same words are honest about a configuration and dishonest about a result.
`unrecorded` reads *"Reproducibility not established"* rather than *"Not reproducible"* —
the run may well be reproducible and we cannot tell, and saying otherwise would invent a
finding.

**Measured before touching the web app**, as FAD-49(3) required: exactly one surface
rendered a RESULT's reproducibility from the request-side mode (`BuildDetailPage`), and one
rendered a CONFIGURATION's (`BuildsPage`) — the latter is correct as it stands and was **not
touched**.

### 21d. The §20c(3) tripwire, updated DELIBERATELY

Its own comment required this: *"if that escalation lands, it fails and must be updated
deliberately."* It landed, and the arm now pins the new honest behaviour on a real solve —
the dispatch mode asserted **unchanged** at `deterministic` (it was never wrong, it was
answering a different question), the result verdict asserted `wall-clock-truncated` with the
clock named, and a falsifiability direction kept: the same run's statistics judged
`reproducible` under the repaired budget, so the arm cannot pass by refusing everything.

### 21e. Both directions pinned, and a mutation arm proving it is load-bearing

| Proof | What it pins |
| --- | --- |
| `packages/domain/test/ports/result-reproducibility.test.ts` (12) | the predicate: four verdicts, the measured stops, the threshold boundary on both sides, exactly-one-reproducible, and that the SENTENCE never carries the promise for a run that cannot keep it |
| `apps/api/test/builds/result-reproducibility-wiring.test.ts` (6) | which COLUMNS the question is asked about — including "the same wall time, two answers" so a derivation reading the wrong budget cannot pass — and fail-closed over seven malformed parameter bags |
| `apps/api/test/builds/e2-quality-and-credits.test.ts` (+1) | over REAL persisted rows: the statistics are there, and a row with no recorded parameter set never claims reproducibility |
| `apps/api/test/solver/e2-objective.test.ts` (§20c(3), rewritten) | the whole chain against a real CP-SAT solve |
| `apps/web/test/build-vocabulary.test.ts` (+3) | the client labels: every refusing verdict reads as a refusal at a glance |
| `apps/web/e2e/builds.spec.ts` AC-31b | the rendered page, both arms, axe green — and that the old promise is **absent** from the truncated page rather than merely joined by a caveat |
| **red case `result-reproducibility-derivation-removed`** | that all of it is load-bearing: with the wall-clock comparison disabled, 6 of 12 domain arms fail |

The red arm is scoped to the domain proof alone, and that is deliberate rather than
convenient — the predicate and the sentence it hands the screen are both there. The client
labels are static strings and cannot detect this mutation, so `build-vocabulary` is **not**
named in the arm: an arm listing a file it does not depend on reads as coverage it has not
got.

### 21f. The granted comment-only correction

`deterministic-cost.test.ts`'s docblock attributed `B-fairness-shaped`'s `FEASIBLE`-vs-`OPTIMAL`
split to *"the deterministic budget stopped the search before optimality was PROVEN"*. It did
not — the wall clock did, at 12–22 of the 100 pinned units, and with the clock out of the way
the same problem proves `OPTIMAL` at 76.702882. The 10.05× ratio in that file's header is
that 10-second clock against a best-effort run finishing in about a second: a real
measurement whose cause was misread. Comment-only; no assertion was wrong, so none changed.

### 21g. Verification, and the two batteries deliberately NOT run

FAD-49(6)'s economics, followed exactly. Serial throughout, idle machine.
Transcripts `32` (named tests + arms) and `33` (the gate battery).

| What | Result |
| --- | --- |
| domain predicate + web labels, standalone | `24 passed (24)`, exit 0 |
| API wiring + the DB-backed row proof, standalone | `14 passed (14)`, exit 0 |
| citation integrity, standalone | `3 passed (3)`, exit 0 |
| the §20c(3) tripwire on a real solve | ×3 — inside two solver arms' GREEN halves and `check`'s unit gate |
| **`corepack pnpm check`** | **17 gate(s): 17 passed, 0 failed**, exit 0 |
| **six red-case arms, both halves, standalone** | **six PROVEN** |

The six arms are every arm this round touched: the new
`result-reproducibility-derivation-removed`, the three whose commands run test files
this round edited (`solver-t2-false-minimality`, `solver-progressive-pin-unfixed`,
`builds-comparability-unenforced`), the one whose command runs the edited web
vocabulary test (`builds-optimality-wording`), and the one whose PATCH targets the
edited `solver-port.ts` (`solver-outcome-honesty`). Each was driven by applying and
reverting its own patch definition in memory, exactly as the runner does; `git diff
--stat solver/` was empty after every one.

**The full 64-arm battery and the full fixture-regression gate were NOT run**, per
FAD-49(6) — they run once on the final candidate at orchestrator acceptance. A
separate integrity check was run instead, over all 56 patch entries in
`scripts/red-cases/run.mjs`: every `find` string still matches its target file, so no
arm has been silently disarmed by this round's edits.

**Two things this round got wrong, and how.** First, `check` came back 16 of 17: the
citation-integrity gate caught a basename citation to a test file that was real on
disk but UNTRACKED, and therefore absent from a fresh clone — fixed by staging the
file, not by rewording the citation. Second, the `builds-comparability-unenforced`
arm's GREEN half failed on this round's own new assertion, which had assumed
`solver_parameters` is present on every completed run; it is written only by the real
dispatch path, and the test was rewritten to assert the fail-closed behaviour that is
actually true (§21b). Both are recorded in transcript 32 rather than quietly fixed.

### 21h. What this does NOT claim

* **The 10-second default is unchanged.** FAD-49(4) records it as an OWNER question: a
  config-time refusal would have to know how many deterministic units a second buys on the
  machine the build will run on, which is exactly the machine-dependent knowledge the
  deterministic budget exists to avoid needing. The honest control is the result-side record,
  and that is what was built. **A build dispatched under the default can still be
  wall-clock-truncated — it now says so instead of claiming otherwise.**
* **No historical row was rewritten.** The verdict is derived on read, so every build already
  in a database gets the honest answer without a migration and without anyone editing
  history. Rows that predate the statistics read `unrecorded`, which is the true answer.
* **`solver/**` was not touched.** `cpsat_adapter.py` still returns `TERMINATION_COMPLETED`
  for a wall-clock-truncated `FEASIBLE`, exactly as FAD-49(1) ruled; the platform carries the
  honesty. Verified byte-identical after every red-case arm that patches it.

## 22. The independent review's REVISE, repaired — FAD-50

Added 2026-08-21. §§0-21 stand; this records the bounded repair round FAD-50 authorized
after the independent review of the complete M4-005 candidate returned **REVISE** — one
blocking finding, seven conditions, twelve notes. The reviewer's probes are on
`review/m4-005` @ `c5fcd4d`; every test named below is implementer-authored, and nothing
was merged from that branch. Transcripts `34`–`35`.

### 22a. B-1 (BLOCKING) — a CANCELLED run rendered `reproducible`

**The finding.** FAD-49's verdict decided from two facts: the pinned parameters and the
recorded wall time. A **cancelled** deterministic run passes both. Its wall time is
*short* — a person pressed stop — and its statistics are persisted like any other, so it
reached `reproducible` and was handed the exact promise sentence FAD-49 exists to delete.
The reviewer reproduced it against real CP-SAT (`CANCELLED`, **2.35s** of wall, **5.6 of
100** deterministic units) and again through the shipped route on a production-path run.

**Why §21 did not catch it.** §21 asked "did the wall clock stop this search?" and treated
`no` as sufficient. It is not: **"the wall clock did not stop it" and "it finished" are
different claims**, and the predicate had no input that could tell them apart. Every arm
in §21e was consistent with the defect, because every one of them varied the budget and
none varied the ending.

**The repair, still a derivation.** `resultReproducibility` now also reads the termination
fact already on the row — `build_runs.termination_reason`, with `solver_status` as a
second belt. **Only a `completed` termination may reach `reproducible`.** No schema change,
no worker change, `solver/**` untouched, exactly as FAD-50 rules.

A **fifth verdict**, `interrupted`, carries the refusal and names what ended the run — five
reasons, five different sentences, because a scheduler re-runs a cancelled build, raises a
budget for a deadline, and reports a crash. It is never conflated with `unrecorded`: there
the facts are **absent**, here they are **present and damning**. One is a gap, the other a
finding.

Two smaller decisions inside it, both stated rather than assumed:

* `terminationReason` and `status` are **required parameters**, not optional ones. B-1 was
  a caller that never had to think about the fact; a defaulted parameter would have rebuilt
  that hole. Making them required turned the compiler into the audit — it named all eleven
  call sites.
* a `CANCELLED` status against a `completed` termination is **refused rather than
  resolved**. `isTerminalOutcomeHonest` rejects that pair upstream, so reaching it means
  something was bypassed, and the safe reading of a contradiction is the one that claims
  less.

**Pinned both directions**, with the reviewer's shapes as permanent tests:

| Proof | Shape |
| --- | --- |
| `result-reproducibility.test.ts` (+8 arms) | the reviewer's exact numbers; every non-completed termination; the completed CONTROL on identical facts; `INFEASIBLE`-that-completed still reproducible; the contradiction pair; termination checked BEFORE the budget so a cancelled run is not miscalled truncated |
| `e2-objective.test.ts` — **RP-1** | a REAL `B-fairness-shaped` solve, cancelled mid-search through the worker's own cancel file: `CANCELLED`/`user_cancelled`, short wall, **not** wall-bound, verdict `interrupted` |
| `result-reproducibility-wiring.test.ts` (+2) | the columns are actually read off the row; an unrecognised termination reads as ABSENT rather than as completed |
| `e2-quality-and-credits.test.ts` — **RP-2** | a production-path run composed exactly as the route composes it and parsed by the route's own `.strict()` contract |

The §20c(3) tripwire was updated **deliberately and disclosed**, as its own comment
required: it now reads the real outcome's termination instead of assuming completion.

### 22b. C-1 — NR-19's release-path unlock had no proof

The reviewer deleted `force_unlock_workers` from `QueuePoolRegistry.release()` and
**nothing shipped failed** — the forty-proof concurrency matrix included. NR-19 was
recorded CLOSED in §4d and §9 on the strength of a repair no test exercised, and the
packet's own "each hardening item lands with its own proof" had not been met for it.

`apps/api/test/db/queue-pool-release.test.ts` is that proof. Two arms: a pool holding a
lease releases cleanly and leaves the job **reclaimable**, and — the reason the close had
to live at `release()` — the stale sweep **cannot reach a released pool at all**, however
old its heartbeat, so a lease held at that moment is never reclaimed rather than reclaimed
late.

**Mutation-checked in both directions**, which is the whole point of the condition:

```
with the call REMOVED   × ...releases cleanly and leaves the job reclaimable
                          → the released pool left its lease on the job:
                            expected 'pool-nr19-8b72b13d' to be null
with the call PRESENT   ✓ 2 passed (2)
```

### 22c. C-2 — the critical path's steps 10–14 asserted almost nothing

Steps 10–11 were wrapped in `if (count > 0 && isEnabled())` with a `console.log` in the
`else`, and `appliedDraft` was computed and never asserted. A refused selection, a control
that never rendered, a click that did nothing — each printed a line and **passed**. Steps
12–14 asserted an `<h1>` was visible and axe was green, which an error page also satisfies.

The reviewer diagnosed the cause, and it was not that the server could not do it: the POST
returns 200, the run reaches `applied_to_draft_schedule`, a new draft id comes back and the
UI renders `build-applied`. **The spec was looking before React's post-invalidate render
settled, and `networkidle` waits for the network, not for a commit.** So the guard was
papering over a wait bug.

Repaired: the guard is **gone**, the selection control is asserted enabled, the outcome is
awaited by its own testid, the **new draft id is read back off the screen** and asserted
different from the source, and the run's state testid is asserted exactly. Steps 12–14 now
assert content — the review surface shows a blocker verdict, the history contains a row
**for the applied draft by id**, ~~and the staff view renders one of its four real states —
including the empty one, which is the correct answer here~~ and does **not** contain the
unpublished draft's id, which is doc 07 §1 seen from the person it protects. The suite now
fails if selection is refused or does not happen.

> **AMENDED 2026-08-21 (FAD-51 D-3).** "Renders one of its four real states" was a weaker
> claim than it sounded: the disjunction admitted the empty AND the non-empty schedule, so
> on desktop — where `schedule-calendar` renders whatever the content is — it could not
> fail for the reason the step exists. Step 14 now asserts the `schedule-status` TEXT
> matches `/^No shifts between /` at both viewports, which is the exact outcome this
> workflow must produce. §23c.

### 22d. C-3 — nothing set `SP_REAL_STACK`, so the marquee suite passed with `2 skipped`

`real-stack-setup.ts` passed `SP_REAL_STACK_API_PORT` to the daemon and never set the
handshake the spec guards on, so `critical-path.spec.ts` skipped under **both**
configurations — and two docblocks said otherwise. `gate:e2e:real-stack` exited **0**.

A suite that reports success for having run nothing is worse than one that fails: it is a
proof that has stopped existing while still appearing in the evidence.

Repaired in one spelling: **`globalSetup` sets it**, after the daemon reports READY and the
origin is listening, so the variable means *the stack is up* rather than *somebody meant to
run it*. Both docblocks corrected, each saying what was false and why it is true now. And
the second half the condition asks for — `support/must-run-reporter.ts` **fails any
real-stack run in which zero tests executed**, counting skips as "did not run", because an
assertion inside the spec cannot fire when the spec does not run.

### 22e. C-4 (RULED) — the staleness wire disclosed qualification-holding identifiers

`constituents` stores `(kind, key, revision)`. For the `qualificationHolding` class the key
is the holding row's **surrogate id** and the revision its version counter — and the detail
GET put that list on the wire for any caller who could read the build, with no
`staffing.qualification_holding.read` grant required. That capability is grant-only and
`SENSITIVE-PII` (`canonical-input.ts` says so). The selection refusal disclosed the same
list.

**The computation stays** — FAD-29's rationale is that an enforcement gate reads the truth,
not the caller's visibility, or a build is declared fresh because the reader cannot see
what moved. **The wire narrows.**

**The measurement the ruling asked for, disclosed.** The only consumer is
`BuildDetailPage.tsx`, and it rendered `{change.kind} {change.key} — {direction}`. Nothing
anywhere read `pinnedRevision` or `currentRevision`. So one surface *did* consume `key` —
and consumed it to print an **opaque UUID** beside a class name, which tells a scheduler
nothing they can act on. Uniform class-level therefore costs the screen nothing, gains it a
count, and avoids a wire whose shape depends on the reader's grants for a field whose only
use was decorative.

`stalenessWire` projects to `(kind, direction, count)`, applied at **both** wire surfaces.
The `changeCount` stays the true total — ~~and the aggregate is now COMPLETE even when the
itemised list it came from was truncated at `CHANGE_LIMIT`, so the bound stops mattering
rather than being inherited.~~

> **AMENDED 2026-08-21 (FAD-51 D-2). The struck sentence was FALSE and is struck rather
> than deleted.** `stalenessWire` aggregated over `verdict.changes`, which
> `compareConstituents` had ALREADY sliced to `CHANGE_LIMIT`, so every per-class count
> inherited the bound while `changeCount` passed through complete — measured, 25 changes
> reported `changeCount: 25` beside a class sum of **20**. The bound had not stopped
> mattering; it had moved somewhere less visible. The same false claim stood in three
> places: this sentence, `constituent-diff.ts`'s docblock, and the arm's own TITLE, whose
> body asserted only `changeCount` — the one field never at risk. §23b records the repair:
> the aggregation happens BEFORE the truncation, so `sum(classes) === changeCount` is now
> an invariant of `compareConstituents` itself, asserted on an over-limit fixture and
> mutation-checked. Five arms pin it, including the deny direction stated as an
absence over the whole serialized payload rather than field by field.

**Recorded as a known cost, with an owner:** the detail GET runs a **full canonical-input
assembly on every read** to compute staleness. That is what makes the answer true, and it
is not free. FAD-50 rules it recorded rather than optimized now; the owner is whoever takes
build-surface performance at M6, alongside the benchmark bands.

### 22f. C-5 to C-7, and the granted note-fixes

| Item | Repair |
| --- | --- |
| **C-5** | `docs/dev-setup.md` — the arm count, 63 → **64** |
| **C-6** | §§18d/19a/19b/19c/20g amended with dated notes — see below |
| **C-7** | `crash-restart.test.ts` — the message now states the predicate it actually asserts: every DRAINABLE job (`outbox.%`, `audit.%`), not "the queue" |
| **N-1(i)** | the runner's inline lines annotate `invertPolarity` arms, so the retained artifact stops contradicting its own summary table |
| **N-1(ii)** | `run()` surfaces a spawn `result.error` as ERRORED — an ENOENT leaves `status: null` and empty output, which read as "GATE FAILED" and was indistinguishable from a gate that ran and failed. The reviewer hit exactly that, silently. **AMENDED 2026-08-21 (FAD-51 D-1): this was NOT met as worded.** The synthesised diagnostic matched no signature — it appended a signature's human REASON rather than text its PATTERN matches — so `erroredReason` still returned `null`. §23a |
| **N-3** | the 10.05× is dated: it was measured under the old 10s wall clock, the ratio was largely that clock, and this file **would not produce it again** under the 900s net. Kept with its conditions stated, because deleting a measurement is worse than dating it |
| **N-4** | `periodic.test.ts`'s "no production sweep will ever reclaim" — false since NR-19, corrected, with the half that is still true (the sweep cannot see a released pool) kept |
| **N-5** | the `reclaimStalePools` docblock moved off `close()`, which ends a connection and unlocks nothing |
| **N-7** | `/me/context` selected **every active group in the organization** to build a counter map from which only the caller's own groups were ever read. Narrowed at the query. This endpoint's entire authorization argument is FAD-25 self-scope, and a map built from groups the caller is not in is not that |
| **N-8** | `apiRequest` spread the context declaration BEFORE `init.headers`, so a caller could silently overwrite its own half of SPEC-01 §2.2's declare/verify contract. Order swapped; a test forges the header and asserts the real counters go out. Mutation-checked — restoring the old order fails it |

### 22g. Recorded, not repaired

* **N-6** — `systemActor` idiom, consistent as it stands.
* **N-9** — the **M-22 numbering gap STAYS**. Non-bypass rule 13: a stable ID is never
  renumbered, and a gap that is recorded costs a reader one sentence while a renumber
  silently corrupts every citation that already looks correct. Recorded here as the gap it
  is.
* **N-10** — **SBX-017's fixture uses a single protected identity.** The scenario proves
  preservation is EXACT for that identity; it does not exercise several protected
  assignments interacting. A limitation of the fixture, not a claim withdrawn.
* **N-11** — **the read-then-write window in `applyCandidateToNewDraft` is admitted and
  undemonstrated.** Staleness is read and the draft written in the same transaction, and
  the reviewer could not falsify a gap between them; nor did this round demonstrate its
  absence. Compensating visibility: staleness is derived on READ, so a build that went
  stale after selection still displays as stale wherever it is looked at. Hardening owner
  M5+.
* **N-1's remaining runner latencies** — `prepareFailed` × `invertPolarity`, and the
  preflight warning that does not fail the run — recorded with the runner backlog.

### 22h. C-6's amendments, and what was FALSE in §19b

**§19b, restated.** The struck line claimed the reproducibility record was an open
escalation. It is not: §21 built the derivation and §22a closed B-1 on top of it. What M4
genuinely does **not** prove is the narrower thing now recorded in its place — that a build
the record calls `reproducible` was actually re-run from its pinned snapshot and produced
the same schedule. S-08t proves bit-identity for two solves in one test; nothing re-runs a
persisted historical build and compares.

**§19c, closed.** The research-validator condition was fixed on `main` at `b370e03` —
eight tracked `.gitkeep` placeholders, `validate.sh` unmodified, the failure reproduced and
the pass proven from clean clones.

**Arm counts.** "63-arm" now reads 64 wherever it appears (§18d, §19a/b, §20g, and
`docs/dev-setup.md`), because FAD-49 added `result-reproducibility-derivation-removed`.

### 22i. Verification

Serial, machine-calm. Per FAD-50 the full 64-arm battery and `fixture-regression` are NOT
run here — they run once at orchestrator acceptance after the delta review.

| What | Result |
| --- | --- |
| **`corepack pnpm check`** | **17 gate(s): 17 passed, 0 failed**, exit 0 — unit `2152 passed \| 14 skipped` |
| **real-stack critical path, both viewports** | **`2 passed`, exit 0** — and the selection is now real: `desktop … source 3abab8e1… -> new draft 6835b4c2…`, `mobile … source 4613bdcb… -> new draft 9b453bb6…` |
| **C-3 forced-skip scenario** | **exit 1** with `REAL-STACK SUITE RAN NOTHING. executed: 0 skipped: 2`. Before the repair this identical situation exited **0** |
| default config still skips as designed | the axe gate passes with `critical-path.spec.ts` collected and skipped — the must-run reporter is wired to the real-stack config only |
| NR-19 mutation, both directions | call removed → the arm fails naming the stranded lease; call present → `2 passed` |
| N-8 mutation | header order restored → the new arm fails; corrected → `10 passed` |
| ten affected red-case arms, both halves | see the table in transcript `34` |

**Three things this round got wrong, recorded rather than smoothed.** The critical path's
step 14 was asserted twice against surfaces that do not render on a narrow viewport, and
failed on **mobile only** both times — first naming two of the four states this view has,
then three. The fourth is the plain "No shifts in this range." paragraph with no testid,
which is the *correct* outcome here because this workflow publishes nothing. Neither
failure was a product defect and neither was a flake; both were caught precisely because
the suite runs at both viewports, which is what C-2 asks of it. The third: the first
version of the RP-2 arm assumed `solver_parameters` is present on every completed run and
had to be pointed at the fail-closed behaviour that is actually true (§21b's limit, met
again).

## 23. The delta review's three conditions — FAD-51, the final round

Added 2026-08-21. The delta review verified B-1 and C-1..C-7 CLOSED using its own round-1
instruments and returned **ACCEPT WITH CONDITIONS**: three modest conditions and one note,
none blocking, all of them defects in §22's own repairs. Reviewer record: `review/m4-005`
@ `db781f8`. Transcripts `36`–`37`.

All three share a shape worth naming, because it is the same mistake three times: **a
repair that reads as done, and is not.** A diagnostic that no detector matches. An
aggregate computed one line too late. An assertion whose title is stronger than its body.
Each passed its own tests; none did what its prose said.

### 23a. D-1 — the spawn diagnostic matched no signature

FAD-50 N-1(ii) asked that a spawn failure read as ERRORED. §22 emitted a diagnostic and
appended what it believed was the matching text — but what it appended was the *human
reason* of the `No test files found` signature (`"vitest matched no test file (a filter or
a path is wrong)"`), not anything the `/No test files found/` **pattern** matches. So:

```
erroredReason(synthesised) = null
```

The diagnostic printed, and the arm still scored **GATE FAILED**. The dangerous case is
asymmetric: **green spawns, red does not** → RED "fails as required", the arm reports
**PROVEN**, and the violation was never tested. That is the decorative red case the runner
exists to detect, arriving through the runner itself — the same sentence
`errored-signatures.mjs` already carried about a different route in.

**Repaired** with a signature of its own, `/could not be spawned/`, matching the wording
the runner actually emits, and the falsifiability check extended to pin a verbatim sample
of that wording — so a reworded diagnostic fails *there* rather than silently downgrading
every future spawn failure. A control was added to the must-NOT-be-errored side too (`PASS
provider-boundary — 4 provider(s) spawned and reaped cleanly`), because the pattern must
match the runner's diagnostic and not the word.

**Provoked end to end**, by the reviewer's method — `pnpm` off PATH, `npm_execpath` unset:

```
spawnSync status = null
spawnSync stdout = ""
spawnSync stderr = ""
spawnSync error  = spawnSync pnpm ENOENT
erroredReason(synthesised) = "the command could not be spawned (a binary is missing from PATH)"
VERDICT = ERRORED  <-- repaired
```

`status: null` with empty output is exactly why this read as an ordinary gate failure: the
runner had nothing to look at.

### 23b. D-2 — the completeness claim was false in three places

`stalenessWire` aggregated over `verdict.changes`, which `compareConstituents` had
**already sliced to `CHANGE_LIMIT`**. So every per-class count silently inherited the
bound, while `changeCount` passed through complete. Measured:

| changes | `changeCount` | itemised list | class sum | complete? |
| --- | --- | --- | --- | --- |
| 25 of one class | 25 | 20 | **20** | **no** |
| 40 of one class | 40 | 20 | **20** | **no** |

And it was asserted nowhere, because the arm that **titled** itself *"the aggregate is
COMPLETE even when the itemised list was truncated"* asserted `changeCount === 40` — the
field that was never at risk — and said nothing about the class counts. Three statements
of the same false claim: this file's docblock ("the projection makes the bound stop
mattering"), INDEX §22e ("the aggregate is now COMPLETE"), and the arm's own title.

**Repaired by moving the aggregation before the truncation.** `compareConstituents` now
computes the `(kind, direction, count)` classes over **every** change and returns them
beside the bounded list; `stalenessWire` does no counting of its own and passes them
through. `sum(classes) === changeCount` is now an invariant *of the function* rather than
of a caller remembering to aggregate first. The itemised list stays bounded at
`CHANGE_LIMIT` and `changeCount` still carries the true total — both unchanged.

| changes | `changeCount` | itemised | class sum | complete? |
| --- | --- | --- | --- | --- |
| 25 | 25 | 20 | **25** | **yes** |
| 40 | 40 | 20 | **40** | **yes** |
| 3 | 3 | 3 | **3** | **yes** |

The arm now asserts the invariant on an over-limit fixture, and a second arm does it across
three classes at once — a single class could be satisfied by a projection that just echoed
`changeCount` into one bucket. **Mutation-checked**: restoring the pre-D-2 aggregation
fails both, `expected 20 to be 40` and `expected 20 to be 45`.

**The screen.** "N input revisions moved" is followed by a per-class list that now sums to
N. The old copy appended ", grouped below by input class" only when
`changeCount > changes.length` — a comparison between a change TOTAL and a CLASS-LIST
length, two different units, which read correctly only while the class counts were
themselves short. The list is always grouped by class now, so the sentence says so
unconditionally and the two reconcile for every input.

### 23c. D-3 — step 14 asserted A state, not THE state

§22c's step 14 was a four-way disjunction over the view spellings, and it admitted **both**
the empty and the non-empty schedule: on desktop `schedule-calendar` renders whatever the
content is, so the assertion could not fail for the reason the step exists. Beside it,
`schedule-status` — the viewport-independent line that carries the exact outcome — was
asserted only `toBeAttached`, which is satisfied while that same element still reads
*"Loading your schedule…"*.

The correct outcome here is **knowable, exactly**: this workflow selects a candidate into a
DRAFT and publishes nothing, so the staff member must have no shifts, and
`announceSchedule` renders `No shifts between <from> and <to>.` — where the non-empty
branch begins with a number instead. So the sentence genuinely discriminates.

**Repaired** to `await expect(status).toHaveText(/^No shifts between /)`, at both
viewports. That pins doc 07 §1 — a draft is invisible to staff — from the side of the
person it protects, and pins it identically on desktop and mobile. The leaked-version-id
negative assertion is kept.

### 23d. D-4 (note) — the log line lagged the corrected message

C-7 corrected the assertion message to name the drainable predicate and left the `log()`
two lines below still saying "the queue is empty". Carried.

### 23e. Verification

Serial, machine-calm. The full 64-arm battery and `fixture-regression` are NOT run here —
they run at orchestrator acceptance with the complete acceptance battery.

| What | Result |
| --- | --- |
| **`corepack pnpm check`** | **17 gate(s): 17 passed, 0 failed**, exit 0 — unit `2153 passed \| 14 skipped` |
| **real-stack critical path, both viewports** | **`2 passed`, exit 0** — step 14 now asserting the exact outcome |
| D-1 ENOENT, end to end | `status: null`, empty output, `spawnSync pnpm ENOENT` → **ERRORED** (was `null` → GATE FAILED) |
| D-1 signature control | `3 detected, 4 correctly left alone`, exit 0 |
| `red-case-runner-errored-signatures`, both halves | **PROVEN** |
| D-2 invariant | complete at 25, 40 and 3 changes; **mutation-checked** — the pre-D-2 aggregation fails both arms |
| affected api tests | `3 files, 63 passed`, exit 0 |

**An integrity failure this round hit twice, recorded rather than quietly fixed.** The
first `check` came back 16/17: the citation gate caught D-1's new verbatim sample, which
named a plausible-looking test path no clone has. The sample is a fixture string and not a
citation — but nothing in the text says so and the gate cannot tell, which is exactly why
it is right to complain. Repointed at a real file. The **second** attempt failed
identically, because the comment explaining the first fix quoted the bad path. That is the
same class as D-1 and D-2 in miniature: the prose describing a repair is not the repair,
and only the gate knows the difference.

### 23f. What the three conditions have in common

Worth stating once, because it is the honest lesson of this round and of the two before it.
Each of D-1, D-2 and D-3 was a repair that **passed its own tests while not doing what its
own prose said**: a diagnostic no detector matched, an aggregate computed one line after
the truncation it was meant to escape, an assertion whose title outran its body. None was
caught by running more of what already existed; each was caught by someone asking what the
claim would look like if it were false, and then measuring. The instruments that found them
— the reviewer's, and the citation gate twice in one afternoon — are the ones that do not
take a sentence's word for it.

---
## 15. Standing facts

* **Synthetic data only.** Every fixture identifier is minted; every date is far-future;
  no organization, site or person name from the research appears anywhere.
* **No test sends a notification to any destination.** Notifications remain outbox
  intents.
* **The source product was not visited.**
* **No ADR was marked accepted, no decision was marked approved, no gate was marked
  passed by anything other than evidence.**
* **No production-readiness claim and no compliance claim of any kind** is made or
  implied.

---

## 24. The orchestrator's acceptance battery — the complete set, serial, on the final candidate (Fable, 2026-08-21)

Written by the orchestrator, not the packet. Independent review verdict: **ACCEPT**
(round 1 REVISE → FAD-50 repair → delta ACCEPT WITH CONDITIONS → FAD-51 final round →
delta-verify ACCEPT; probes retained on `review/m4-005` @ `bdd78dc`). Every command below
ran on `4f41935`, serially — each result read and validated before the next launch — on a
verified-calm machine (1-min load 1.37 at start, zero processes, zero listeners), with
`SP_SOLVER_WORKER_COMMAND` at the FAD-7 venv interpreter.

| # | Command | Result | Exit | Transcript |
| --- | --- | --- | --- | --- |
| 0 | `python3 docs/architecture/validate.py` · `python3 docs/fable/validate.py` | 95/95 · 36/36 | 0 · 0 | (inline) |
| 0b | `bash schedulepoint-research/validate.sh` from a GENUINELY FRESH clone of main `927c98c` | PASS | 0 | (inline; the `b370e03` placeholder fix proven) |
| 1 | `corepack pnpm check` | **17 gates: 17 passed, 0 failed** — unit 2153 passed \| 14 skipped, axe green | 0 | `38` |
| 2 | `corepack pnpm red-cases` | **64 case(s): 64 proven, 0 not proven** — the first fully-green complete battery of the milestone | 0 | `39` |
| 3 | `corepack pnpm fixture-regression` | **153 run(s): 153 passed, 0 failed** — 13 fixed seeds incl. 123456 and 531651, rotating seed 35396, full standalone sweep, baseline-immutability clean | 0 | `40` |
| 4 | `corepack pnpm sbx` | **9/9 executed and passed** — 0 vacuous, 0 probe errors; 371 readings / 53 of 53 tables / 0 wrong-tenant | 0 | `41` |
| 5 | migration populated cycle | **0001–0019 CLEAN by name**, up → down → up → down → up | 0 | `42` |
| 6 | real-stack critical path (`real-stack.config.ts`) | **2 passed (39.4s)** — both viewports, zero skipped (the C-3 must-run reporter armed) | 0 | `43` |
| 7 | hygiene | 0 processes, 0 listeners, no dist artifacts, no cluster, tree clean | — | (inline) |

The M1–M4 regression is the composition of rows 1–3 per doc 35 §6g's acceptance
definition. Rows 2 and 3 are the milestone's first complete green runs of both batteries
on any tree.
