# EV-M4-INPUT-A — OPUS-M4-000A, staffing-input integrity

**Task:** OPUS-M4-000A (packet [35](../../fable/35-m4-task-packets.md) §3) ·
**Branch:** `opus/m4-000a-staffing-input` · **Base:** `666d15a` (frozen M3
checkpoint `7b579f2` + docs 34/35) · **Prerequisite register rows closed:**
doc 34 §4-A, §4-B.

Everything in this bundle was produced by running the commands in §7; the raw
outputs sit beside this file. Where a claim could not be verified by running
something, it says so.

---

## 1. What shipped

| # | Deliverable | Where |
|---|---|---|
| 1 | Migration `0012_staffing_input_integrity.sql` (up/down/up/down/up clean) | `apps/api/migrations/` |
| 2 | `staffing_set_versions` — the DB-owned aggregate CAS counter (FAD-24 precedent), trigger-maintained, no runtime write grant | migration 0012 §1 |
| 3 | Whole-set weekday-demand replacement: delete-absent canonical rule, aggregate `expectedVersion`, advisory-lock serialization, byte-level no-op, load-before-edit GET | `apps/api/src/catalogue/{service,staffing-set-version}.ts`, `catalogue.route.ts` |
| 4 | Whole-set period-requirements replacement, same mechanism, per period | `apps/api/src/schedule/service.ts` `replaceRequirements`, `schedule-authoring.route.ts` |
| 5 | Qualification-requirement set replacement under the same aggregate CAS; retired qualifications refused from entering the set | `catalogue/service.ts` `replaceShiftTypeQualifications` |
| 6 | `requires_expiry` enforced at service AND database (trigger), incl. the flip guard | `profiles/qualifications.ts`; 0012 §3 |
| 7 | Retired-qualification refusals (new holdings; new/reactivated requirement rows), existing rows retained | `profiles/qualifications.ts`; 0012 §3–4 |
| 8 | Row CAS (`version` + `expectedVersion`) on qualification and holding mutations | 0012 §2; `profiles/qualifications.ts`; contracts |
| 9 | Future-effective work-profile cancellation: future-only DELETE (guards narrowed per the 0011 CREATE-OR-REPLACE precedent), continuation row, audited, in-force row never touched | 0012 §5; `profiles/work-profiles.ts` `cancelFutureWorkProfile`; `POST …/work-profiles/:id/cancel` |
| 10 | **The shared eligibility verdict** — pure, five distinct non-satisfied outcomes | `packages/domain/src/eligibility/` (new, frozen to 000B/C) |
| 11 | Manual path converged on the verdict (incl. qualification lifecycles) | `catalogue/service.ts` `listMembershipEligibility` |
| 12 | Publication converged: `heldOn` via the verdict + the STRUCTURAL requirement gate (no duplicate authored rule needed) | `schedule/hard-rule-revalidation.ts` |
| 13 | The enforcement read plane for the gate (additive RLS policy, purpose-token, set-and-cleared) | 0012 §6; `hard-rule-revalidation.ts` |
| 14 | Web editors: demand form loads-before-edit and carries `expectedVersion`; requirements panel presents the whole set; stale → explicit reload flow | `apps/web/src/catalogue/ShiftTypesPage.tsx`, `apps/web/src/schedule/{api.ts,PeriodsPage.tsx}` |
| 15 | SBX-004 sweep floor raised: `TENANT_TABLES` 45 → **46** (`staffing_set_versions`) | `apps/api/src/db/schema.ts` |
| 16 | One additive audit event name: `staffing.work_profile.cancelled` (proposed for FAD ratification) | `packages/domain/src/audit/event-names.ts` |
| 17 | Migration `0013_work_profile_delete_capability.sql` — the review-condition C1 close (finding F-1): both work-profile DELETE guards gain the capability gate. **Added after the review, not part of the original packet** — see §10 | `apps/api/migrations/` |

## 2. The canonical omitted-entry rule, stated once

**Saving produces exactly the presented set; an entry omitted from the request
is DELETED.** Two surface-specific halves, each stated in the contract and on
the page:

- **Catalogue weekday demand** additionally normalises zero to absent — the
  FAD-16 read has always defined an absent row AS zero demand, so a zero row
  would be a second spelling of one fact and the eight-field form could never
  no-op.
- **Period requirements** store an explicit zero — a period-dated zero
  overrides what a weekday default would imply (doc 07 §1's
  default-vs-instance distinction), so zero and absent are different
  statements there.

No observed-model conflict was found (FAD-16's read semantics are the source
of the zero half; delete-absent contradicts no research entry — the demand
tables are pure quantities, and the audit chain plus, from M4-001, the
immutable `solver_inputs` snapshot carry the historical record).

## 3. The retired-qualification rulings (authored for FAD ratification)

R1. A **new holding** naming a retired qualification is refused — service
    (`QUALIFICATION_RETIRED`, 422) and database
    (`qualification_holdings_guard_expiry_retirement`, 23001).
R2. **Existing holdings are retained**, readable, windows and status
    unchanged; their status machine keeps working (revoking a holding of a
    retired qualification remains possible).
R3. A retired qualification **ceases to confer eligibility**: the shared
    verdict evaluates the lifecycle FIRST and answers the distinct outcome
    `retired` — even over an in-window `valid` holding. Fail-closed, the
    FAD-27 direction; an unresolvable lifecycle is also `retired`, never
    `satisfied`.
R4. A **new `shift_type_qualifications` row** naming a retired qualification
    is refused, in BOTH "new" shapes: fresh INSERT and reactivation of an
    archived row (`shift_type_qualifications_guard_retirement`). A row already
    active stays active — retirement never rewrites existing requirements.
R5. (Adjacent, same family) `requires_expiry` cannot be flipped ON while
    open-ended live holdings exist (`qualifications_guard_requires_expiry_flip`)
    — the two-statement bypass of the holding-boundary rule.

## 4. The verdict, and the pinned classification

`packages/domain/src/eligibility/verdict.ts` — pure, no clock, instant is a
parameter (S-03: the row in force at the build instant; consumers pass
`transactionNow` or `instantOfDate`). Per required qualification:

1. lifecycle retired/unresolvable → **retired** (first, fail-closed)
2. any in-window holding with status ∈ {valid, expiring} → **satisfied**
3. no holding at all → **missing**
4. any revoked holding → **revoked** (loudest fact, whatever the window)
5. window reached-and-passed or status `expired` → **expired**
   (half-open boundary: valid *until* the instant is OUT at the instant)
6. window ahead, or `pending` in-window → **future**

Aggregate precedence: revoked > expired > future. Unparsable bounds are
ignored (fail-closed to `missing`). Membership/work-profile dimensions carry
an explicit `not-evaluated` arm — absence never manufactures ineligibility
(FAD-23 preserved; the three-state display semantics are untouched, asserted
by the unchanged authoring-surface tests).

## 5. The enforcement read plane (security-relevant; for ratification)

Migration 0012 §6 adds ONE additive SELECT policy on `qualification_holdings`:
rows are readable when the conjunctive tenant predicate holds AND the
transaction-local setting `app.enforcement_read` equals the literal purpose
token. `hard-rule-revalidation.ts` sets it via `set_config(name, value, true)`
immediately before the gate's holdings reads and clears it in a `finally`.
Why: the publication gate must compute on the truth — a publisher without
`staffing.qualification_holding.read_any` would otherwise see every assignee
as uncredentialed and the gate would refuse valid schedules (FAD-23's
access-control-artefact warning, in the blocking direction), while requiring
publishers to hold the read key would violate FAD-25's "write never implies
read". RLS stays ENABLED+FORCEd; tenant boundaries unchanged; only a verdict
leaves the computation. Proven load-bearing in
`test/schedule/qualification-requirement-gate.test.ts` (the publisher-context
read is EMPTY without the token, and the gate still publishes a credentialed
schedule); falsified by the `enforcement-read-plane` red case (token
misspelled → the gate under-reads and the proof fails).

## 6. Named proofs (each carries a mutation control)

| Proof | File |
|---|---|
| 12-round demand whole-set race, DB-asserted, union control | `apps/api/test/catalogue/demand-replacement.test.ts` |
| 12-round requirements whole-set race over HTTP, DB-asserted | `apps/api/test/schedule/authoring-concurrency.test.ts` (B-1, rewritten) |
| FAD-24 emission control, both directions | `demand-replacement.test.ts` |
| requires-expiry + retired refusals, service AND DB layers, trigger-suspension mutation controls | `apps/api/test/profiles/staffing-integrity-red-cases.test.ts` |
| Row CAS + DB-owned counters + monotonic guard | same file |
| Verdict property tests, five outcomes, expiry-vs-assignment boundary, order independence, broken-variant controls | `packages/domain/test/eligibility/verdict.test.ts` |
| Manual-path ≡ publication-path verdict equality (same fixture, same instant), off-by-one-day control | `apps/api/test/profiles/verdict-convergence.test.ts` |
| Future-profile cancellation (continuation, bounded, audited, in-force untouched byte-for-byte) | `apps/api/test/profiles/work-profile-cancellation.test.ts` |
| Structural publication gate + enforcement-plane load-bearing proof | `apps/api/test/schedule/qualification-requirement-gate.test.ts` |

New red-case arms in `scripts/red-cases/run.mjs`: `noop-audit-emission`,
`requires-expiry-service`, `retired-verdict`, `enforcement-read-plane`; the
existing `stale-edit-cas` arm retargeted to the aggregate advisory lock in
`acquireStaffingSet` (its requirement-lock target was superseded by this
packet).

## 7. Commands run — actual results (outputs beside this file)

Every row is one command, run in this worktree, exit code read directly. The
whole battery below was run against the tree at commit `6a6a0ea`.

| Command | Exit | Result | Output |
|---|---|---|---|
| `corepack pnpm check` | **0** | 13/13 gates PASS. Unit: **115 files, 1444 tests**, 0 failed. axe/Playwright: **343 passed, 13 skipped**. Slowest gates: axe 181.2s, unit 86.0s | `check-output.txt` |
| `corepack pnpm red-cases` | **0** | **25 cases: 25 proven, 0 not proven** — including this packet's four new arms (`noop-audit-emission`, `requires-expiry-service`, `retired-verdict`, `enforcement-read-plane`) | `red-cases-output.txt` |
| `corepack pnpm fixture-regression` | **0** | **107 runs: 107 passed, 0 failed.** 13 fixed seeds + fresh rotating seed **929597** (1000 api tests each) + all 93 files standalone. Two earlier runs FAILED — §9 | `fixture-regression.txt` |
| `corepack pnpm sbx` | **0** | **6 scenarios, 6 PASS**, every probe FALSIFIABLE, **0 vacuous assertions**. SBX-004: **45 tenant tables** swept as five roles, **315 readings across 7 contexts, 0 wrong-tenant rows, 45/45 tables observed with visible rows**; API arm 93/93 routes | `sbx-run.txt` |
| `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | **0** | **MIGRATION CYCLE CLEAN — up → down → up → down → up**, 12 migrations each direction incl. `0012_staffing_input_integrity`; **0 tables and 0 policies remaining after down**; 1038ms | `migration-cycle.txt` |
| The seven named proofs, each run standalone | **0** ×7 | demand-replacement 4 · authoring-concurrency 3 · staffing-integrity-red-cases 15 · verdict (domain) 25 · verdict-convergence 6 · work-profile-cancellation 5 · qualification-requirement-gate 3 — **61 tests, 0 failed** | `named-proofs-standalone.txt` |

**The sweep floor, precisely.** `TENANT_TABLES` went **45 → 46** entries
(`staffing_set_versions`); the SBX-004 SQL arm sweeps **45** of them directly
and went **44 → 45** against the M4 entry record (doc 34 §2). The new table is
observed non-vacuously — `staffing_set_versions: max 4 visible
(app_runtime/runtime/group-one)`. No table left the sweep.

**The three modes, per the packet's acceptance line.**

| Mode | Where | Result |
|---|---|---|
| **standalone** | `named-proofs-standalone.txt`, one command per file, each with its own cluster | 7/7 exit 0 |
| **in-suite** | the `unit` gate of `corepack pnpm check` — one `vitest run` over all five projects | 115 files / **1444 tests**, PASS |
| **full battery** | `fixture-regression.txt` — 14 whole-suite runs with file AND test order shuffled (1000 api tests each), then all 93 api files alone | 107/107 |

The api proofs also appear individually in the gate's own standalone sweep
(§3 of `fixture-regression.txt`): `catalogue/demand-replacement 4`,
`schedule/authoring-concurrency 3`, `profiles/staffing-integrity-red-cases 15`,
`profiles/verdict-convergence 6`, `profiles/work-profile-cancellation 5`,
`schedule/qualification-requirement-gate 3`.

## 8. Honest notes

- The per-cell requirement PUT (and its `requirementRevision` token) is
  SUPERSEDED by the whole-set aggregate; the old contract schemas remain
  exported (additive discipline) but no route speaks them.
- `setRequirement` (single-row service upsert) is retained for fixture
  seeding; the editor route no longer reaches it.
- Schedule fixtures that publish on the requirement-bearing shift type now
  opt into `seed.scheduleCredentials` (production-path holdings for the
  assignees); `seedSchedule` itself moved to the unencumbered shift type. The
  eligibility proofs keep their uncredentialed member (no flag there).
- `grantHolding` deliberately carries NO expectedVersion: nothing mutable is
  read to become stale, and a duplicate issue is refused by
  `qualification_holdings_unique_issue`.
- **The granted-while-retiring race is NOT closed at the trigger.** An earlier
  revision of this section claimed it was. That claim was wrong and the
  independent review falsified it deterministically (finding F-2, probe P3e):
  with the grant transaction held open across the retirement's commit, the
  0012 trigger's lookup had already returned `active` under READ COMMITTED, so
  nothing refused — the grant committed and **a holding of a now-retired
  qualification exists in the table** (`committedHoldings=1`,
  `qualification=retired`). What is true is the OUTCOME, and it is true for a
  different reason: the shared verdict evaluates the lifecycle FIRST (§4 rule
  1, ruling R3), so such a holding confers nothing on either consumer — the
  manual eligibility read and the publication gate both answer `retired`. The
  safety property is therefore supplied by the **verdict layer as a fail-safe
  outcome**, not by write-prevention at the database. Stated precisely: the
  interleaving is admitted; the credential it produces is inert.

## 9. The fixture-regression gate FAILED twice before it passed

Full record: `isolation-defect-hunt.txt`, plus the two failing runs themselves
(`fixture-regression-run1-failed.txt`, `fixture-regression-run2-failed.txt`).
They are attached rather than discarded because FAD-15 ruling 3 makes a
shuffled-seed failure a defect record, not a failed attempt.

**Run 1 — exit 1, 95/107, twelve of the fourteen shuffled runs failed.** Three
test-order couplings this packet introduced, all closed in commit `6a6a0ea`,
all in test files (no production change was needed or made):

1. `history-immutability.test.ts` T-05 was moved onto a **past-dated** window
   by this packet (a future one is now legitimately deletable through 0012's
   cancellation path) — and it planted that window on `telecom`, the very
   membership T-01's before-first case counts pre-2010 rows on to prove its
   retro-dated authoring wrote nothing. Whenever T-05 ran first it supplied the
   row T-01 then blamed on the service. Subject moved to `groupOnly`, which no
   other case in the file names.
2. `work-profile-cancellation.test.ts`'s audit case counted every cancellation
   event in the organization and asserted **three** — one per sibling case
   above it. It now authors and cancels its own predecessor and first-ever
   pair on two `full`-profile memberships and scopes the read to the subject
   ids it created (2 cancelled, 1 continuation).
3. `qualification-requirement-gate.test.ts`'s blocked arm assigned the same
   membership the next case credentials, so only the authored order worked. It
   now assigns a membership nothing in the file ever credentials; and the
   mutation control, which was vacuous whenever it ran first, grants its own
   holding and asserts the row exists before claiming the token-less read's
   emptiness means anything.

**Run 2 — exit 1, 106/107.** One fixed seed (20250101), one test:
`profiles/loader-writer-agreement.test.ts > an actual supersession closes the
row the precondition named, and no other`. **This is UNRESOLVED.** It is in a
file this packet does not modify, over a function (`authorWorkProfile`) that is
byte-identical to `666d15a`; it does not reproduce at its own seed or at the
seed it first appeared under; **47 whole-suite shuffled runs after the repair
produced 0 reproductions**, and run 3 passed clean. The gate prints only the
failing test name, so the assertion behind it has never been captured. It is
reported as an open finding rather than called a flake — nothing here fixed it
and nothing here explains it.

**Run 3 — exit 0, 107/107**, rotating seed 929597. That is the run in
`fixture-regression.txt` and the one §7 reports.

---

## 10. Review-condition closure (ACCEPT WITH CONDITIONS → closed)

The independent review of this packet returned **ACCEPT WITH CONDITIONS**. What
follows is the closure: what changed, and the battery re-run in full on the
resulting tree. §7 above is left exactly as written — it is the true record of
the battery at commit `6a6a0ea`/`eb7b5d8`, and this section is the true record
of the battery afterwards. Neither replaces the other.

### 10.1 The conditions, and what closed each

| # | Finding | Change |
|---|---|---|
| **C1** | **F-1 (MEDIUM)** — 0012's two narrowed work-profile DELETE guards check FUTURENESS but not CAPABILITY, so a raw DELETE of a strictly-future row by an `app_runtime` principal holding no staffing capability was admitted at the database (the HTTP path is gated, so this was defence-in-depth asymmetry, not a live hole) | **New migration `apps/api/migrations/0013_work_profile_delete_capability.sql`.** 0012 is not edited. Both guard bodies gain `PERFORM app_require_capability('staffing.work_profile.administer', OLD.organization_id)`. New red-case arm `work-profile-delete-capability`; three new proof arms in `staffing-integrity-red-cases.test.ts` |
| **C2** | **F-3 (citation integrity)** — two comments cite `apps/api/test/schedule/requirement-replacement.test.ts`, which does not exist | Both retargeted to the real proof, `apps/api/test/schedule/authoring-concurrency.test.ts` (B-1): `apps/api/src/schedule/service.ts:281` and `scripts/red-cases/run.mjs:383`. A repo-wide search found **exactly these two** occurrences and no others |
| **C3** | **F-2 (accuracy)** — §8 claimed "the granted-while-retiring race is closed by the 0012 trigger" | §8 rewritten to state what was measured. See the bullet there: the race is **not** closed at the trigger; safety comes from the verdict layer as a fail-safe outcome, not from write-prevention |
| **C4** | *(optional, authorized)* aggregate precedence not visible to the api-side convergence proof | Taken, not skipped. One new self-contained case in `verdict-convergence.test.ts` arranges **three holdings of one qualification** and asserts the fold on BOTH consumers: expired > future, then revoked > expired |

### 10.2 The capability token, and why it is that one

`staffing.work_profile.administer`.

It is the same capability the service layer checks for this operation and it is
spelled per the database convention already established for these tables:

- the cancel route `POST …/work-profiles/:workProfileId/cancel` declares
  `AUTHOR_WORK_PROFILE_CONFIG` (`apps/api/src/http/routes/profiles.route.ts`),
  whose `action.key` is **`staffing.work_profile.administer`** (baseline
  `CAP-013`), evaluated at SPEC-06 L4 inside the transaction before
  `cancelFutureWorkProfile` issues a statement;
- migration 0004 already writes exactly
  `PERFORM app_require_capability('staffing.work_profile.administer', NEW.organization_id)`
  in `app_guard_work_profile_administration` and
  `app_guard_weekday_fte_administration`.

No capability is created, widened or narrowed (non-bypass rule 11): the token
already exists in `STAFFING_CAPABILITIES`, is already grant-only, and is
already what 0004 requires to WRITE these rows. DELETE was the one widened
grant whose guard did not ask.

**Ordering inside each guard is deliberate: retention first, capability
second.** The retention rule is absolute and capability-independent, and
0012's proof that it binds the OWNER is exactly the demonstration that must not
be lost. Asking the capability question first would turn every owner refusal
into `42501` and the `WORK_PROFILE_RETAINED` rule would stop being observable
at all. So each guard answers: (1) in force or elapsed → `23001`, for every
principal, unchanged; (2) otherwise, may this membership cancel → `42501`. A
dedicated proof arm asserts that ordering.

### 10.3 The new red case

`work-profile-delete-capability`, in `scripts/red-cases/run.mjs`. The violation
is applied to the MIGRATION itself — the api project's global setup runs the
migration cycle against a freshly initialised cluster on every `vitest run`, so
the guards under test are literally the patched ones.

| Arm | Result |
|---|---|
| **GREEN** (clean tree) | pass — the uncapabilitied DELETE is refused `42501`, the granted path still cancels |
| **RED** (both `PERFORM` lines removed) | fails as required — the uncapabilitied DELETE returns `ACCEPTED` |
| **MUTATION CONTROL** (in-test, `session_replication_role = replica`, always rolled back) | the DELETE lands, proving the refusal is the trigger's doing and the assertion can fail; the rolled-back state is verified gone |

The legitimate path is asserted green in the same run:
`work-profile-cancellation.test.ts` (5 tests) is in both the GREEN and RED
commands and stays passing.

### 10.4 The battery, re-run in full on the closure tree

Every row is one command, run in this worktree, exit code read directly.

| Command | Exit | Result | Output |
|---|---|---|---|
| `corepack pnpm check` | **0** | **13/13 gates PASS.** Unit: **115 files, 1448 tests**, 0 failed (1444 → 1448: 3 new C1 arms + 1 C4 case). migration-rls gate now scans **13 migration files**. axe: **343 passed, 13 skipped**. Slowest: axe 178.9s, unit 86.0s | `condition-closure-check.txt` |
| `corepack pnpm red-cases` | **0** | **26 cases: 26 proven, 0 not proven** — 25 → 26 with `work-profile-delete-capability`. Doubles as the reviewer's **condition 5** (a clean end-to-end red-cases run on a clean tree) | `condition-closure-red-cases.txt` |
| `corepack pnpm fixture-regression` | **0** | **107 runs: 107 passed, 0 failed.** 13 fixed seeds + fresh rotating seed **849638**, **1004 api tests** each, file AND test order shuffled; all 93 files standalone. Order-independent under every seed tried; shared baseline unmodified in every run | `condition-closure-fixture-regression.txt` |
| `corepack pnpm sbx` | **0** | **6 scenarios, 6 PASS**, 0 failed, 0 blocked, **0 vacuous**, 0 probe-error. SBX-004 unchanged at **45 tenant tables** / 93 routes — correctly, since 0013 creates no table and touches no grant | `condition-closure-sbx.txt` |
| `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | **0** | **MIGRATION CYCLE CLEAN — up → down → up → down → up**, **13 migrations each direction**; `0013_work_profile_delete_capability` applied 3× UP and 2× DOWN; **0 tables and 0 policies remaining after down**; 1009ms | `condition-closure-migration-cycle.txt` |
| The named proofs, each standalone | **0** ×7 | demand-replacement 4 · authoring-concurrency 3 · staffing-integrity-red-cases **18** · verdict (domain) 25 · verdict-convergence **7** · work-profile-cancellation 5 · qualification-requirement-gate 3 — **65 tests, 0 failed** (61 → 65) | `condition-closure-named-proofs.txt` |

**Nothing failed and nothing was re-run to make it pass.** The open
intermittent recorded in §9 (`loader-writer-agreement.test.ts`, seed 20250101)
did **not** reproduce in this battery either; it remains **UNRESOLVED** and
this closure neither explains nor fixes it.

### 10.5 Files added by the closure

| File | What it is |
|---|---|
| `apps/api/migrations/0013_work_profile_delete_capability.sql` | The C1 migration (additive; no table, no policy, no grant change, RLS untouched, no stable ID removed) |
| `condition-closure-check.txt` | `pnpm check`, exit 0 |
| `condition-closure-red-cases.txt` | `pnpm red-cases`, exit 0, 26/26 |
| `condition-closure-fixture-regression.txt` | `pnpm fixture-regression`, exit 0, 107/107, rotating seed 849638 |
| `condition-closure-sbx.txt` | `pnpm sbx`, exit 0, 6/6, 0 vacuous |
| `condition-closure-migration-cycle.txt` | The 13-migration cycle, exit 0 |
| `condition-closure-named-proofs.txt` | The seven named proofs standalone, exit 0 ×7 |
