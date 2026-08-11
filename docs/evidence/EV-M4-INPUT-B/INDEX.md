# EV-M4-INPUT-B — OPUS-M4-000B evidence

**Packet:** OPUS-M4-000B — schedule-graph consistency, group-scoped relationships,
locations, and time. Doc 34 §4-C / §4-E / §4-F; doc 35 §4 (as amended 2026-08-10,
FAD-30, and by the E1/E2/E3 adjudications of 2026-08-11).

**Branch** `opus/m4-000b-schedule-graph-time` · **worktree** `.worktrees/m4-000b`
**Migration** `0014_schedule_graph_locations_time.sql`
**Base** `a0f1bcc` (M4-000A close-out)
**Independent review:** ACCEPT WITH CONDITIONS → **all conditions closed** (§10)

Synthetic data only. Far-future dates (2027–2038). No real name, no real
notification, no live organization.

---

## 1. Battery captures

| Step | File | Result |
|---|---|---|
| 1 | `step-1-check.txt` | **EXIT=0 — 13 gates, 13 passed.** unit 1593/1593 · axe 197s, 355 e2e passed · request-budget PASS |
| 1 (failed) | `step-1-check-FAILED-e2e-mocks.txt` | **EXIT=1 — 11 passed, 2 failed.** Retained; diagnosis in §4 |
| 2 | `step-2-red-cases.txt` | **EXIT=0 — 33 cases, 33 proven, 0 not proven** |
| 2 (failed) | `step-2-red-cases-FAILED-decorative-arm.txt` | **EXIT=1 — 32 proven, 1 NOT PROVEN.** Retained; diagnosis in §4 |
| 3 | `step-3-fixture-regression.txt` | **EXIT=0 — 113 runs, 113 passed.** 13 fixed seeds + **rotating seed 768920**, 1067 tests per run, file AND test order shuffled; full standalone sweep; baseline-immutability control clean in every run |
| 4 | `step-4-sbx.txt` | **EXIT=0 — 6/6 scenarios, 0 vacuous, 0 probe errors.** SBX-004: 315 readings across 7 contexts, **0 wrong-tenant rows, 45/45 tenant tables observed non-vacuously**; 93 organization-scoped routes byte-identical foreign-vs-nonexistent |
| 5 | `step-5-named-proofs.txt` | Named proofs **three ways** — standalone, in-suite, full battery. §2 |
| 6 | `step-6-closure-check.txt` | **EXIT=0 — 13/13 gates.** unit 1636/1636 (post-condition-closure) |
| 7 | `step-7-closure-red-cases.txt` | **EXIT=0 — 33/33 proven.** `dst-fold-resolution` re-verified `pass / fail / PROVEN` after B-1 enlarged its file |
| 8 | `step-8-closure-fixture-regression.txt` | **EXIT=0 — 113/113.** Fresh **rotating seed 952830**, 1069 tests per run |
| 9 | `step-9-closure-sbx.txt` | **EXIT=0 — 6/6 scenarios, all FALSIFIABLE, 0 vacuous.** 315 readings / 7 contexts, **0 wrong-tenant rows, 45/45 tables**; floor still 45 |

**Sweep floor: 45, unchanged.** Migration 0014 adds no table — only constraints,
triggers and two columns — so the floor was expected to hold rather than rise.
Stated before the run, not after.

## 2. Named proofs, three ways

All nine files pass **alone**, **with their siblings**, and **in the full battery**.

| Proof file | Standalone | In-suite | Full battery |
|---|---|---|---|
| `packages/domain/test/calendar/calendar-date.test.ts` | 45/45 | domain 357/357 (13 files) | 1630/1630 |
| `packages/domain/test/time/zoned-time.test.ts` | 43/43 | domain 357/357 | 1630/1630 |
| `packages/contracts/test/schedule/calendar-date.test.ts` | 31/31 | contracts 35/35 (2 files) | 1630/1630 |
| `apps/api/test/schedule/graph-invariants.test.ts` | 21/21 | api schedule 224/224 (21 files) | 1630/1630 |
| `apps/api/test/schedule/locations.test.ts` | 6/6 | api schedule 224/224 | 1630/1630 |
| `apps/api/test/schedule/timezone-basis.test.ts` | 6/6 | api schedule 224/224 | 1630/1630 |
| `apps/api/test/schedule/membership-semantics.test.ts` | 12/12 | api schedule 224/224 | 1630/1630 |
| `apps/api/test/schedule/migration-0014-populated-cycle.test.ts` | 1/1 | api schedule 224/224 | 1630/1630 |
| `apps/api/test/schedule/calendar-agreement.test.ts` | 14/14 | api schedule 224/224 | 1630/1630 |

Full battery: **124 files, 1630 tests, 0 failed** (from 117/1537 at packet start).

## 3. Migration 0014 cycle

Two independent cycles, both green:

1. **Empty-database cycle** — `globalSetup` runs up → down → up before every
   `vitest run`; every capture above therefore contains one.
2. **POPULATED-fixture cycle** — `migration-0014-populated-cycle.test.ts`, which
   the packet requires. Eleven tables populated through the production write path
   (a real V1 → V2 history: published, superseded, reality rows, supersession
   record, two publication records, a credit, a requirement, a located shift),
   then the **real `migrate()` runner** down 1 and up 1.

```
populated: schedule_periods=1 schedule_versions=2 schedule_requirements=1 shifts=2
           assignment_identities=2 assignment_snapshots=2 credits=1
           current_published_assignments=1 publication_records=2
           version_supersessions=1 locations=1
cycle: 0014_schedule_graph_locations_time down and up; every census digest identical
```

**Data preservation, stated exactly.** Every ROW survives with an identical
content digest (`digestRows`, order-independent). **Two named exceptions**:
`timezone_basis` and `tzdb_version` are columns 0014 *adds*, so its down
migration drops them and their values do not survive — they return as NULL,
which classifies as `unrecorded`, an explicitly permitted state that still
publishes. Asserted in the test rather than glossed. A cycle report claiming
"all data preserved" while silently emptying two columns would be worse than a
failure.

## 4. Retained FAILED captures, with their diagnoses

A discarded failure without a recorded cause is how a signature gets normalized.
Both are kept.

### `step-1-check-FAILED-e2e-mocks.txt` — EXIT=1, axe + request-budget

**Symptom.** axe 1,271s (vs 197s green); 7 request-budget violations.
**Not** axe violations — 30.0s timeouts on every interaction test in
`schedule.spec.ts` / `my-schedule.spec.ts`, and the 7 "violations" were all
`no recording for budgeted interaction`, i.e. missing recordings from
interactions that never completed.

**Cause.** This packet made 3 `gridAssignment`, 4 `scheduleGrid` and 5
`scheduleEntry` fields REQUIRED on `.strict()` schemas. The mocked fixtures in
`apps/web/e2e` still returned the old shapes, so the client-side zod parse threw,
the page rendered nothing, and every `getByTestId` waited out its timeout.

**Fix.** Fixture functions `assignment()` / `grid()` (`schedule.spec.ts`) and
`entry()` (`my-schedule.spec.ts`) updated. `publication.spec.ts` was unaffected —
it uses the change/diff schemas, touched only by the tightened `isoDate` alias,
and its fixture dates are real. Verified before re-running the gate: the two
specs went from per-test 30s timeouts to **30.4s for the whole file**.

### `step-2-red-cases-FAILED-decorative-arm.txt` — EXIT=1, 1 NOT PROVEN

**Symptom.** `calendar-date-shape-only`: GREEN passed, RED **also** passed —
"GATE STILL PASSED — decorative".

**Cause, measured rather than hypothesised.** Two runs of the same arm differing
only by a rebuild:

| | source patched | dist rebuilt | api arm |
|---|---|---|---|
| A | yes | no | **8/8 PASS** |
| B | yes | yes | **6 FAIL** |

`apps/api` resolves `@schedulepoint/contracts` through the package's `exports`
entry → `dist/`. The red-case runner patches SOURCE and invokes vitest with no
build in between, so the api test imported the unpatched build. **No violation
ever reached the executed code.** Not "a sibling control caught it" — the control
was never the problem; run B proves it bites hard.

**Fix (never weakening the control).** New
`packages/contracts/test/schedule/calendar-date.test.ts` imports
`../../src/schedule/calendar-date.js` — source-relative inside its own package —
so the patch *is* the code that runs. The arm now targets it: GREEN 31/31 →
RED 13 failed. See §7 for the systemic finding this exposed.

## 5. Rulings offered for FAD ratification

| ID | Ruling |
|---|---|
| **R-B1** | Only an `active` membership is a NEW assignment target. `invited`, `suspended` and `ended` are refused, at the service (typed error) and at the database (trigger). |
| **R-B2** | A NEW assignment must fall inside the membership's effective window: `starts_at >= valid_from`, and `ends_at <= valid_to` where `valid_to` is set. SPEC-06 L3.3's authorization window, applied to the work rather than to the actor. |
| **R-B3** | EXISTING assignments are RETAINED when a membership later changes state. The guard fires on INSERT and on a change of `membership_id`, and on nothing else — cancelling, pinning and re-timing an assignment belonging to a since-suspended member all still work. **No manual-override arm**: FAD-23's override answers an access-control *absence*; membership state is fully visible, so an override would override a fact, not a judgement. |
| **R-B4** | A DST **gap** (a local time that does not exist) resolves **FORWARD by the transition's own gap duration** — 30 min in Lord Howe, 1 h in Toronto, 2 h in Troll. Carried as data (`normalization: 'gap-forward'`, `shiftedByMillis`, `resolvedLocalTime`), never silent. Refusing was rejected: shift-type times are fixed catalogue values, so refusal would make one calendar day per year unschedulable with no authoring remedy, and the hour still needs covering. |
| **R-B4a** | **When a shift's START is gap-normalized, the WHOLE interval translates forward by the same gap width** — the end moves with the start. Added by review finding B-1 (§10). Resolving the endpoints independently inverted any shift SHORTER than the gap: **399** measured (start, end) pairs produced a zero or negative interval across the three fixture zones (New York 78, Lord Howe 21, Troll 300). A residual typed `DegenerateShiftIntervalError` remains as a backstop, not the mechanism. |
| **R-B5** | *(corrected by B-1)* A DST **fold** (a local time that happens twice) resolves **by ROLE: a shift START takes the earlier occurrence, a shift END the later.** One rule, not two — earliest-for-both makes a spanning shift an hour short; latest-for-both starts it an hour late and leaves the repeated hour uncovered. Start-early/end-late covers the repeated hour exactly once. **The original wording also claimed this pairing "guarantees `endsAt > startsAt`". That was FALSE for gap-normalized starts and is withdrawn** — non-degeneracy is R-B4a's property, not this one's. |
| **R-B6** | **A location's `timezone` is DISPLAY METADATA. The GROUP's timezone governs every schedule semantic** (doc 06 §Time). Every instant derivation, day window, DST resolution and date attribution uses `groups.timezone`; `locations.timezone` is shown to a human and nothing computes from it. Letting a location's zone govern would leave D-1a/D-1b comparing instants across a group with no comparable *local day*. |
| **R-B7** | **A published version renders under the zone it was PUBLISHED with** (`schedule_versions.timezone_basis`), so a group-timezone change cannot move immutable history (I-18). A **draft** authored against the outgoing zone is reported STALE and refused at publication (`TIMEZONE_BASIS_STALE`). Aggregating staff views cut their **calendar axis** in the group's current zone — a view must present one calendar — while each entry states its own rendered zone and source. This resolves the display-semantics question M3 recorded and deferred (`EV-M3-SETTINGS`). |

Supporting note on the tzdb identifier: recording `tzdb_version` makes a rule-set
divergence **detectable**; it does not make an old interpretation reproducible.
This repository has one tz database — the runtime's — and nothing here claims
otherwise.

## 6. New audit-payload key

`schedule.version.published` gains a scalar `timezone` field (the zone id, or
`unrecorded` for a pre-0014 version). Additive, scalar, closed-payload-safe. No
new event name, no new subject type.

## 7. Systemic finding — decorative red-case arms (for the register)

**Any red-case arm that patches package SOURCE but asserts only through a DIST
consumer cannot observe its own violation.** `packages/{domain,contracts}` are
consumed by `apps/api` through their `exports` entries, which resolve to `dist/`;
`scripts/red-cases/run.mjs` patches source and runs vitest with no build step.

Three cases have the shape. Two are mine and are now correct:

| Case | Owner | State |
|---|---|---|
| `calendar-date-shape-only` | 000B | **Was NOT PROVEN.** Repointed to a source-relative contracts-package test. Fixed |
| `dst-fold-resolution` | 000B | PROVEN via its domain test, but it also listed `apps/api/test/schedule/authoring-time.test.ts`, which *cannot* observe the patch and read as corroboration it never provided. **Narrowed to the domain test** |
| `retired-verdict` | **000A** | PROVEN via its domain test; its api arm is decorative corroboration. **NOT EDITED** — `scripts/red-cases/**` is 000B's for *additions*, and rewriting another packet's case is not an addition. Raised here for the reviewer / FAD |

Suggested standing rule: a red case must name at least one test that imports the
patched file **source-relative within its own package**, or must build between
patch and run.

## 8. Files

Evidence: `INDEX.md` · `step-1-check.txt` · `step-1-check-FAILED-e2e-mocks.txt` ·
`step-2-red-cases.txt` · `step-2-red-cases-FAILED-decorative-arm.txt` ·
`step-3-fixture-regression.txt` · `step-4-sbx.txt` · `step-5-named-proofs.txt`

## 9. What this packet does NOT claim

No production-readiness claim. No compliance claim of any kind. Doc 34 §4-D,
§4-G and §4-H belong to OPUS-M4-000C and are untouched here. `packages/domain/src/eligibility/**`
was consumed read-only and is unmodified. Manual scheduling remains override,
recovery and fixed-input only (I-05, non-bypass rule 7). Placeholder/functional
participants are explicitly **out of scope** for M4 solver input and are
representable only as unmet demand — recorded, owner-visible, and not invented.

---

## 10. Independent review — condition closure

Verdict **ACCEPT WITH CONDITIONS**. All 11 FK forgeries, the deferred guard
(including `SET CONSTRAINTS` and savepoint defeat attempts), the R-B1/2/3
boundaries, the gap-width mutation control and render stability HELD under
reviewer-authored attack. All four provisional rewrites judged sound — N-5's
original cross-group class was verified unconstructible **by attack**, so that
acceptance is now final.

### B-1 (BLOCKING) — degenerate DST-gap intervals — CLOSED

`resolveShiftInterval` returned `ends_at < starts_at` for a shift starting
inside a DST gap: R-B4 pushed the START forward, the END resolved where it was,
and any shift shorter than the gap inverted. Reachable through
`schedule-authoring.route.ts` → `addManualAssignment`, dying as a **500** on the
`assignment_snapshots_interval` CHECK.

*Enumerated rather than sampled* — 5-minute grid over each gap window:

| Zone | Gap | Degenerate pairs BEFORE | AFTER |
|---|---|---|---|
| `America/New_York` | 1 h | 78 | **0** |
| `Australia/Lord_Howe` | 30 min | 21 | **0** |
| `Antarctica/Troll` | 2 h | 300 | **0** |
| **Total** | | **399** | **0** |

Semantics chosen: **R-B4a**, joint resolution (§5). Refusing was rejected for
R-B4's own reason — shift-type times are fixed catalogue values, so refusal
makes one calendar day a year unschedulable with no authoring remedy, and the
hour still needs covering; refusing only *short* shifts would be a rule whose
behaviour flips on duration.

Why the original proof missed it: the gap fixture used `02:30 → 10:00`, seven
and a half hours — long enough that pushing only the start still left the end
well ahead. It passed and proved nothing about the broken case.

New coverage: three sub-gap-width fixtures (30 min in a 1 h gap, 15 min in
30 min, 60 min in 2 h), each asserting the authored duration survives and the
shift moved by the **measured** gap; plus an exhaustive re-enumeration asserting
0. Reachability closed separately: `addManualAssignment` now refuses a
non-advancing interval with a typed `ASSIGNMENT_INTERVAL_INVALID` before
touching the database. The CHECK remains the control.

### B-2 (BLOCKING) — `TIMEZONE_BASIS_STALE` answered 404 — CLOSED

The code was missing from `CONFLICT_CODES`, so `outcomeOfServiceError` fell
through to `not-found`: a scheduler with a stale draft was told their version
**does not exist**. `timezoneBasisStaleBodySchema` was referenced by nothing.

Closed by its own outcome member carrying both zones (not a generic conflict —
the remedy is neither "retry" nor "re-read"), rendering the contract body with
`recordedTimezone`/`currentTimezone`, **plus** the code added to
`CONFLICT_CODES` as a backstop. Branch order is load-bearing and commented:
`TimezoneBasisStaleError` extends `SchedulePreconditionError`.

New HTTP-level proof asserts **409**, both zones in body *and* prose, version
unmoved — with a **CONTROL** publishing successfully once the zone is restored.

Why the original proof missed it: §3 asserts on the thrown error and never
crosses the HTTP boundary. That is exactly the gap an HTTP-level assertion
closes.

**Region disclosure:** `apps/api/src/http/routes/schedule-publication.route.ts`
was outside the E2 grant. The review condition names the file and lines, and it
was treated as the extension. Recorded rather than assumed.

### C-3 — `staleDraftVersionIds` docstring — CLOSED (docstring corrected)

It claimed parity with `publishedVersionCount`; the value never reaches the
wire. Corrected to state plainly that it is a **service-level** report, name
where staleness *does* reach a human (grid `role="alert"`; publication 409), and
what it is for. Adding it to the settings response would have been a third
publication of the same fact.

### C-4 — `VERSION_ROW_COLUMNS` — CLOSED (removed)

Confirmed dead (only build artifacts referenced it) and removed. Its comment
claimed to make "no column untested" structural; V-18 actually provides that, by
enumerating `information_schema` at run time — and picked up this packet's two
new columns on its own, 13 → 15. A hand-maintained list claiming a structural
guarantee is worse than no list.

### Not mine

The reviewer confirmed by measurement that **000A's `retired-verdict` api arm is
decorative** (§7). That repair is assigned at merge integration, not to this
packet.
