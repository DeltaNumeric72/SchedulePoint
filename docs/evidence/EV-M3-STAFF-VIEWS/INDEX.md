# EV-M3-STAFF-VIEWS — OPUS-M3-006, staff-facing schedule views

**Task:** OPUS-M3-006 (packet [32](../../fable/32-m3-task-packets.md) §10e) ·
**Branch:** `opus/m3-006-staff-views` · **Base:** `112b8c4` (rebased as SECOND MERGER
onto OPUS-M3-005; originally cut from `d12d469`) ·
**Carried M2 item closed:** §2 row 10 — the scheduler-vs-calendar-key grant edge
(the ruling is §3 below; **RATIFIED pending the claim-accuracy delta**, to be
recorded as FAD-25 at merge).

Everything in this bundle was produced by running the commands in §8. Where a
claim could not be verified by running something, it says so.

---

## 1. What shipped

| # | Deliverable | Where |
|---|---|---|
| 1 | Personal published schedule (current version only, self-scoped) | `GET …/published-schedule/members/:membershipId?from&to` |
| 2 | Daily assignment sheet for a date (a read of the published master schedule) | `GET …/published-schedule/daily-sheet?date=` |
| 3 | Wire contracts | `packages/contracts/src/schedule/views.ts` + barrel line |
| 4 | Two additive group-scoped READ action keys | `packages/domain/src/authz/catalogue.ts`, `authz/cross-product.ts` |
| 5 | Accessible calendar **and** first-class tabular alternative, mobile layout, 320px | `apps/web/src/my-schedule/**` |
| 6 | Server-resolved timezone rendering, overnight shifts on both days | route + `views.ts` + `model.ts` |
| 7 | The calendar-key edge ruling (§3) | this document; implemented behind a narrow seam (§3.4) |
| 8 | New red case `draft-invisibility` | `scripts/red-cases/run.mjs` |
| 9 | Four additive request budgets | `scripts/gates/request-budget/budgets.json` |

**No migration. No edit to `apps/api/src/schedule/**`. No audit-module edit. No
mutation of any kind on this surface** — the module contains no INSERT, UPDATE
or DELETE, because a published version is immutable (I-18) and staff read it.

---

## 2. The two reads, and the doc 07 distinction they respect

Doc 07 §1 keeps ten schedule concepts apart. Two of them decide this surface:

| Concept | What this packet did with it |
|---|---|
| **Published schedule version** — "an immutable, staff-visible snapshot" | both routes read only this |
| **Draft schedule version** — explicitly "not visible to staff" | invisible at the QUERY level (§4.2) |
| **The daily assignment sheet** (CAP-020, doc 07 §7) | a read of the published master schedule for a date |
| the picklist `daily_assignments` module | **NOT built, not touched, not referenced.** M9 |

The daily sheet offers no turn, no pick position, no claim and no sequence, and
the e2e asserts that no control matching `take|claim|pick|pass` exists on the
page. Collapsing those two concepts is the specific failure doc 07 §1 exists to
prevent, and it would have been easy: both are "who is working today".

---

## 3. **RULING — the scheduler-vs-calendar-key grant edge** (packet §2 row 10)

**Status: RATIFIED pending the claim-accuracy delta (N-1..N-4), to be recorded as
FAD-25 at merge; surfaced in the M3 exit report for owner confirmation.** CK-1,
CK-2 and CK-3 stand as written below and the two keys are unchanged.

**A note on citations in this bundle.** Every "§6 of the roles document" reference
below names `docs/fable/08-roles-and-permissions.md` in full. Under the repo's
citation convention a bare "doc 08" resolves to `docs/architecture/08`, whose §6
is Explainability — a different document. The packet's own shorthand caused the
ambiguity; it is spelled out here rather than inherited. The one exception is the
D-10 blockquote in §3.1, which is **verbatim** from EV-M2-CATALOGUE and keeps that
bundle's original shorthand — a quotation is not edited to fix its citation; the
document it means is the same `docs/fable/08-roles-and-permissions.md` §6.

### 3.1 What the edge actually is

The carried item reads "Scheduler-vs-calendar-key grant edge (write-not-read)".
Its origin is EV-M2-CATALOGUE finding **D-10**:

> **A scheduler cannot read the group holiday calendar.**
> `group.holiday_calendar.administer` is a group-administrator key (doc 08 §6
> "Group settings"), and **reads are gated by the same key as writes** (D-4), so
> a scheduler authoring shift-type demand cannot see which dates the `holiday`
> demand row applies to.

So the edge has two halves, and only naming both makes it resolvable:

1. **write-not-read**, from the scheduler's side: a scheduler *writes* content
   whose meaning depends on the calendar (`shift_type_weekday_demand.day =
   'holiday'`) and cannot *read* the calendar that gives it meaning;
2. **read-implied-by-write**, from the key holder's side: whoever holds the
   calendar key can read what they can write, because one key gates both — which
   is convenient and is exactly the coupling that produced (1).

### 3.2 The ruling

**CK-1 — reading one's own published schedule is self-scoped and independent of
every scheduler and administrator key.**

The path is exactly this, and nothing else grants it:

| | |
|---|---|
| **action key** | `schedule.own_published.read` (group-scoped, `core_scheduling`) |
| **route** | `GET /organizations/:o/groups/:g/published-schedule/members/:membershipId` |
| **baseline capability** | CAP-020 |
| **object policy** | `requiresObjectPolicy: true`, `ownershipRequired: true`, **no `ownershipOverrideCapability`** |
| **held by** | `member`, `viewer`, `scheduler`, `group_admin` — role-implied, not grant-only (`docs/fable/08-roles-and-permissions.md` §6, "View published schedules") |
| **not held by** | `telecom` (`docs/fable/08-roles-and-permissions.md` §6 marks its "View published schedules" cell `—`) |

No grant of `schedule.publish`, `schedule.revert`, `schedule.version.edit`,
`schedule.period.administer`, `schedule.catalogue.administer` or
`group.holiday_calendar.administer` is a prerequisite for it, and **none of them
substitutes for it**. A scheduler sees their own schedule because they are a
member of the group, not because they are a scheduler — asserted in the suite:
a scheduler holding all five of those keys is refused a colleague's personal
view (`404`), and reads their own successfully.

**CK-2 — a calendar-key holder can read what they can write, and that stays true
for the holiday calendar; but the general rule this packet adopts is the
opposite, and both new keys follow it.**

*Write never implies read, and read never implies write.* The two keys added here
are read-only: neither confers any power to change anything, and neither widens
any existing write. `schedule.published.read` exists precisely so that a
staff-facing read is not gated on an authoring key — which is the D-10 shape,
and gating a member's own rota on `schedule.version.edit` would have reproduced
it exactly.

**CK-3 — the holiday-calendar half is a recommendation, deliberately not
implemented here.** The proposed fix is to split
`group.holiday_calendar.administer` into a read key (role-implied for
`scheduler` and `group_admin`, because a scheduler authoring holiday-conditioned
demand needs it) and a write key (`group_admin`). **This packet does not do it**:
it touches the catalogue surface this packet may not edit, it changes the
reachability of an existing write key, and it needs its own allow/deny battery.
It is recommended to **OPUS-M3-008**, which already owns the composition and to
which EV-M2-CATALOGUE routed the D-10 product question.

### 3.3 Why "no ownership override" rather than "schedulers may look"

An override would have been the easy default (`documents.manage` is the
precedent on the context probe). It is refused because a personal view is a
different artifact from a rota: it is *about one person*, and a surface that lets
one member request another member's personal view is a per-person lookup by URL.
The information a scheduler legitimately needs is already available to them, on
two surfaces that are separately authorized and separately audited:

- the **daily sheet**, which shows everyone working a date
  (`docs/fable/08-roles-and-permissions.md` §6 makes this a shared read: knowing
  who is on with you is why a rota is published);
- the **authoring grid** (M3-004), gated on `schedule.version.edit`.

So the ruling costs no capability. It removes one path, and the path it removes
is the one with no legitimate consumer.

### 3.4 The narrow seam (reversing it is one line)

The ruling lives in **one declaration**: `OWN_SCHEDULE_CONFIG.action` in
`apps/api/src/http/routes/schedule-views.route.ts`. Adding
`ownershipOverrideCapability: '<key>'` to it makes exactly the named
administrative capability lift the ownership requirement, through the shipped
evaluator, with no other change anywhere. Removing `ownershipRequired: true`
would make the personal view group-wide. Nothing else in the file reads either
field.

---

## 4. The five key proofs

All five are in `apps/api/test/schedule/views-http.test.ts` (18 tests) over the
real database, with a published history seeded through the production write path
(`createPeriod` → `createDraftVersion` → `addManualAssignment` → `transitionVersion`
→ `publishVersion`), plus `views-time.test.ts` (11 tests) for the pure functions.

### 4.1 Self-scoping — and byte-identical denial

| Request (as Alpha's `member`) | Result |
|---|---|
| own membership | **200**, only their own rows, only the current published version |
| another member of the same group | **404** |
| a membership in Alpha's Group Two, under Group One's context | **404** |
| a membership id naming nothing | **404** |
| a malformed id | **404** |
| as `scheduler`, another member's view | **404** — no override exists |

The three 404 bodies are compared **byte for byte** with the correlation id
normalised, and are identical:

```
{"error":{"code":"NOT_FOUND","message":"Not found.","correlationId":"<id>"}}
```

Two independent mechanisms produce it, and both are asserted:

1. **authorization** — SPEC-06 L5.1 with ownership required denies
   `OBJECT_POLICY`, whose disclosure class is `not-found`;
2. **the query** — the personal read filters on `uow.context.membershipId`, the
   *verified* context's membership, never on the path parameter. If the policy
   declaration were disarmed, the rows returned would still be the caller's own.
   The test asserts the denial is a 404 and **not** a 200 carrying the caller's
   own data, because a route that silently substituted "self" for any requested
   membership would be a lie the caller could not detect.

**No cross-group EX-2 read is performed.** The context probe does one so an
authorized actor receives `409 CONTEXT_TARGET_MISMATCH`; on this surface that
`409` would tell a member that a named person exists in another group. The target
is resolved inside the group-scoped unit of work, so a sibling group's membership
is simply invisible.

### 4.2 Draft invisibility, at the query level

The fixture seeds a **draft version carrying an assignment for the same member on
a date inside the same range**, so the only thing keeping it off the wire is the
predicate. Three assertions:

1. the draft row exists (`select count(*) … where v.state = 'draft'` → `1`) — the
   non-vacuity control;
2. **the predicate is the only thing hiding it**: the route's own selection is
   run twice against the database, once with the two clauses and once without —
   `2 rows with it, 3 without`. If those agreed the predicate would be
   decorative;
3. the draft appears on **neither** surface: not in the personal view (no entry
   on its date, no entry carrying its `versionId`) and not on the daily sheet for
   its date (`entries: []`).

A fourth, unasked-for property fell out and is asserted: after a second
publication supersedes the first, the personal view reads **version 2 only** —
`is_current` is part of the predicate, so history is invisible too. The view is
the schedule as it *is*.

**Each clause is individually load-bearing — measured, after a reviewer showed
the earlier claim was not.** An independent review removed each clause on its own
and the file still passed 18/18: publication step 08 supersedes the outgoing
version AND clears its `is_current` in one transaction, so on any state the
application can produce today either clause alone suffices. **Nothing enforces
that coupling** — there is no CHECK saying `is_current ⇒ state = 'published'`.

So the suite now crafts both decoupled states, through transitions the database
itself permits (no trigger disabled, no constraint dropped), inside a transaction
that is rolled back:

| Crafted state | How it is reached | both clauses | state-only | is_current-only |
|---|---|---|---|---|
| `published`, **not** current | D-15b's own outgoing-version transition (`is_current` true→false) | — | **2 (leaks)** | — |
| `draft`, **current** | the guard's frozen branch does not apply to a draft; D-16's partial unique index is free because the row above cleared it | — | — | **1 (leaks)** |
| shipped predicate | both clauses | **0** | | |

Measured: `decoupled states: both clauses 0 rows · state-only 2 (published, not
current) · is_current-only 1 (draft marked current)`. Each clause is what excludes
one of the two. The probe also asserts the rollback really rolled back.

**The red case, and exactly what it proves.** `draft-invisibility` in
`scripts/red-cases/run.mjs` deletes the two clauses and runs `gate:unit`.
Measured: the suite fails. **It fails at the first of two independent controls,
and this bundle says so rather than implying otherwise** — with the predicate
gone the draft's rows *are* selected (proof 2 above shows that directly), and the
response then fails to serialize, because a draft version has no
`version_number` (D-9 allocates it inside the publication transaction) and the
contract requires a positive one. The observed red arm is therefore six failing
tests reporting `expected 500 to be 200`, not a rendered draft. That is a
stronger position than one control, and it is recorded here so nobody later
reads the red arm's output and concludes the case is testing something it is not.

### 4.3 Overnight rendering — both days, labelled

Fixture: a 22:00 → 06:00 shift in `Pacific/Auckland`, seeded as the instants
`2029-06-06T10:00Z – 2029-06-06T18:00Z`.

| Day | `isContinuation` | `continuesToNextDay` | rendered as |
|---|---|---|---|
| 2029-06-06 | `false` | `true` | "22:00 until 06:00 the next day (7 June 2029)" |
| 2029-06-07 | `true` | `false` | "Continues from 22:00 on 6 June 2029, until 06:00" |

Both entries carry the **same `assignmentIdentityId`**: it is one assignment
rendered twice, which is why `isContinuation` is a required field rather than an
optional hint — a reader that counted rows without it would count the shift
twice. The daily sheet for 7 June carries the continuation too.

The exclusive-end rule is proven separately in `views-time.test.ts`: a shift
running 16:00 → 00:00 does **not** occupy the following day. Without it every
evening shift in the system would put a phantom entry on the next morning's
sheet.

### 4.4 Timezone correctness under a non-UTC group zone

The group's zone is set to `Pacific/Auckland` through the **real settings route**
as a group administrator, before anything is published. Every fixture instant
falls on a different UTC date from its local one, so a rendering that used the
UTC date, the server's zone, or the snapshot's `date` column without converting
produces the wrong day for every row:

- `2029-06-03T20:00Z` renders as **2029-06-04, 08:00–16:00**;
- the personal view has **zero** entries on 2029-06-03.

`views-time.test.ts` drives the conversion across **two DST transitions, each from
both sides** — the US spring-forward and the New Zealand end-of-daylight-time,
four assertions over two transitions — and asserts midnight renders `00:00` and
never `24:00`, the literal the exclusive-end rule tests for.

The window itself is selected by **instant overlap**, not by a date range on the
snapshot's `date` column: a date predicate would miss the overnight shift that
started the day *before* the window and runs into it, which is the very case this
packet exists to render. Widening a date predicate by a day would work for shifts
under 48 hours and fail silently for anything longer.

### 4.5 Cross-group denial

Covered in §4.1: byte-identical to a membership that does not exist, for both the
authorization and the query reasons. The daily sheet is group-scoped by RLS and
by the unit of work; there is no parameter on it that names another group.

---

## 5. Authorization — the two new keys, and the deny arms

| Role | `schedule.own_published.read` | `schedule.published.read` | Measured |
|---|---|---|---|
| `member` | ✓ (own only) | ✓ | 200 / 200 |
| `viewer` | ✓ (own only) | ✓ | 200 / 200 |
| `scheduler` | ✓ (own only) | ✓ | 200 own, **404** another's |
| `group_admin` | ✓ | ✓ | (role map) |
| `telecom` | — | — | **403** / **403** |

Telecom's denial is a `403` rather than a `404` because the actor holds an active
membership in the declared tenant and its existence is already known to them
(SPEC-06 P-6). An ALLOW control precedes every deny (FAD-15 vacuity discipline):
the same route, the same body shape, an authorized actor, 200.

**Both keys are additive and RATIFIED pending this delta (to be recorded as
FAD-25 at merge).** Neither expands the 58-capability baseline — both routes declare `CAP-020` in `policy.capability`;
these are ACTION keys, the unit SPEC-06 L4 evaluates. `SYSTEM_ROLE_CAPABILITIES`
in `packages/domain/src/authz/cross-product.ts` is edited as the other half of
the same additive vocabulary change, following the precedent OPUS-M3-007
recorded for its three settings keys: a key declared and held by nobody would
make the surface unreachable for the roles
`docs/fable/08-roles-and-permissions.md` §6 assigns it to.

**Disclosed deviation from `docs/fable/08-roles-and-permissions.md` §6.** That row
marks Org Admin `✓` for "View published schedules". Neither key is on an organization role, because a
group-scoped key cannot be held through an organization role (P-10); an
organization administrator who needs to read a group's schedule holds a
membership in it. This is the same disposition OPUS-M3-007 recorded for group
settings.

---

## 6. Interface evidence

24 screenshots in `screenshots/`, both viewports, one per state — they feed the
M3 exit's real-browser evidence.

| State | Files |
|---|---|
| calendar (desktop) | `my-schedule-calendar.desktop.png` |
| tabular alternative | `my-schedule-list.desktop.png`, `my-schedule-list-mobile.mobile.png` |
| overnight, both days | `my-schedule-overnight.{desktop,mobile}.png` |
| loading / empty / error / denied / not-found | `my-schedule-{loading,empty,error,denied,not-found}.*.png` |
| daily sheet, empty, denied | `daily-sheet{,-empty,-denied}.*.png` |
| keyboard journey (Enter on a calendar day → the sheet) | `my-schedule-keyboard-daily-sheet.desktop.png` |
| 320px | `my-schedule-320px.mobile.png`, `daily-sheet-320px.mobile.png` |

Asserted in `apps/web/e2e/my-schedule.spec.ts` (38 passed, 8 project-scoped skips):

- **zero axe violations** including `best-practice`, on every state, at both
  viewports;
- **the calendar and the alternative render the same entries**, compared as
  sorted sets of `data-entry-summary` — neither walks the API response, both walk
  `model.ts`;
- **keyboard**: arrow keys move by a day, Down moves by a week, Enter opens the
  daily sheet for the focused day; the roving tabindex skips the alignment
  blanks and is re-homed when the window changes;
- **programmatic status**: `role="status"` `aria-live="polite"` regions on both
  pages, announcing the count and the continuations, and naming the zone;
- **the interface never lies about authority**: a `403` renders "no permission",
  a `404` renders "not found", and the denial body is asserted to contain no
  capability key, no layer and no explanation;
- **320px**: `scrollWidth - clientWidth <= 0` on both pages.

### 6.1 Request budgets (I-10 / SP-HR-2)

| Interaction | Budget | Measured |
|---|---|---|
| `my-schedule-switch-view` | **0** | 0 at both viewports |
| `my-schedule-next-window` | 1 | 1 at both viewports |
| `daily-sheet-open-from-calendar` | 1 | 1 **desktop only** — the calendar is the desktop default, the narrow viewport opens on the list, so the recording e2e is skipped on mobile and no mobile recording exists. The ledger note in `budgets.json` says the same. |
| `daily-sheet-next-day` | 1 | 1 at both viewports |

The zero is the load-bearing one: both renderings come from data the page already
holds, so choosing the accessible alternative costs nothing. A fetch there would
make the alternative more expensive than the calendar, which is how an
alternative becomes a degraded mode.

**I-13 is not applicable** — there is no Add, New or Create control on this
surface, and no control that persists anything. The budgets above are recorded in
its place, as the packet requires.

---

## 7. Known limitations, honestly stated

1. **The membership id is a path parameter.** There is no client-side
   session-context read yet (the context probe is a POST harness route, not a
   `/me`), so the shell has nowhere to learn the viewer's membership from. The
   server answers from the verified context regardless, so a hand-edited URL
   naming somebody else is a `404` — but the URL shape is interim, and when a
   session read lands the shell should supply it.
2. **No feed or token export**, by scope. An iCalendar/webcal export is a
   delivery mechanism with its own privacy posture and belongs to the
   notification/calendar milestone. Recorded, not built.
3. **The M3-007 display-semantics question is untouched.** Whether an
   already-published assignment should render at its original wall time or at the
   new zone's equivalent instant after a timezone change is still open
   (EV-M3-SETTINGS). This surface renders every instant against the group's
   **current** zone, which is one of the two answers — it is not a decision this
   packet made, and the question stays open for the M3 exit.
4. **The red arm reports the contract control, not a rendered draft** (§4.2).
5. **The holiday-calendar read/write split is recommended, not implemented**
   (§3.3, CK-3) — recommended to M3-008.
6. **No real assistive-technology session.** SPEC-14's `M` cells stay honestly
   unclaimed; axe is not a screen reader.
7. **The daily sheet is not self-scoped, by design**
   (`docs/fable/08-roles-and-permissions.md` §6). If the owner
   ever wants a group whose members cannot see each other's shifts, that is a
   product decision and a narrowing of `schedule.published.read`, not a defect
   here — recorded so the disposition is explicit rather than assumed.
8. **The personal view's range bound is `MAX_VIEW_DAYS = 92`**, a product bound
   with no database half. A longer range is refused with a field-addressed 422;
   it is never truncated.
9. **The initial window is chosen from the BROWSER's local date** — four weeks
   from the Monday of the viewer's current week. That is the one date the client
   computes, and it decides only which window to *ask about*; every rendered date
   and time in the response was resolved by the server against `groups.timezone`.
   A viewer in a different zone from their group can therefore land on a window
   offset by a day from the one a colleague sees, which is harmless for a
   four-week window and would not be for anything narrower. If the surface ever
   defaults to "today", the default must come from the server.

---

## 8. Commands, with results

**All figures below are from the post-rebase run on the composed branch** (base
`112b8c4`, with M3-005's publication surface merged first). Where a number
differs from the pre-rebase run it is because the composition added M3-005's
tests, routes, budgets and red case — noted per row.

| Command | Result |
|---|---|
| `corepack pnpm install` | exit 0 |
| `SP_TEST_PREVIEW_PORT=4320 corepack pnpm check` | **13/13 PASS**, exit 0 — **1305 tests / 102 files** composed (1275/99 this packet + M3-005's 30/3); 91 registered routes ([check-output.txt](check-output.txt)) |
| `SP_TEST_PREVIEW_PORT=4320 corepack pnpm red-cases` | **20 case(s): 20 proven, 0 not proven**, exit 0 — composed: this packet's `draft-invisibility` and M3-005's `publish-idempotency-key-retained` ([red-cases-output.txt](red-cases-output.txt)) |
| `corepack pnpm fixture-regression` | **96 run(s): 96 passed, 0 failed** (93 → 96 with M3-005's three files) — "Order-independent under every seed tried. Every file also passes alone." ([fixture-regression.txt](fixture-regression.txt)) |
| `corepack pnpm sbx` | **6/6 PASS**, probe FALSIFIABLE on every one, **0 vacuous assertions**; sweep **308 readings, 0 wrong-tenant rows, 44 of 44 tables observed with visible rows** ([sbx-run.txt](sbx-run.txt)) |
| `pnpm --filter @schedulepoint/api migrate:cycle:embedded` | **MIGRATION CYCLE CLEAN — up → down → up → down → up**, `0001..0010`, 1115ms ([migration-cycle.txt](migration-cycle.txt)) |
| `views-http.test.ts` standalone | **19 passed** ([named-proofs-standalone.txt](named-proofs-standalone.txt)) |
| `views-time.test.ts` standalone | **11 passed** ([named-proofs-standalone.txt](named-proofs-standalone.txt)) |
| `playwright test my-schedule` | **38 passed, 8 skipped** (project-scoped) ([e2e-output.txt](e2e-output.txt)) |

Per the standing verification discipline, both new proof files were run
**standalone** as well as inside the battery, and both results are reported. Per
the standing NR-14 discipline, every regenerated artifact belonging to another
bundle was restored with `git checkout --` before committing; this bundle's own
artifacts are the run above.

### 8.1 Two seeds that failed under machine CONTENTION, and their serial re-run

During the claim-accuracy delta the coordinator's own verification battery was
running concurrently in `.worktrees/m3-005-rev` and `-adv`. Two seeds failed with
the signature the runbook's standing note describes — "whole test FILES fail with
tests SKIPPED and zero tests failed ... read it as contention, then re-run
serially before concluding anything about the code":

| Seed | Duration | Result | File |
|---|---|---|---|
| 7 | **993.9s** (≈25× the ~40s typical) | 887 passed, **6 skipped**, 0 failed | `test/settings/timezone.test.ts` |
| 531651 | 246.4s | 2 failed | `test/audit/crash-restart.test.ts` — the C-2 lease proof, which measures **wall-clock** reclaim (the runbook records 574–576 ms) and is therefore the first thing to fail on a saturated machine |

**Neither file is in this packet's diff.** Re-run serially on a quiet machine
with the harness's own invocation, both pass in full
([contention-seeds-serial-rerun.txt](contention-seeds-serial-rerun.txt)):

```
--sequence.seed=7        79 files, 893 passed (893)   44.18s
--sequence.seed=531651   79 files, 893 passed (893)   43.27s
```

The post-delta `pnpm fixture-regression` is 93/93 with no failures at all.

### 8.2 The fixture-regression run that FAILED first, and why it is filed here

The first `corepack pnpm fixture-regression` run was **93 run(s): 84 passed, 9
failed** — nine of nine shuffled seeds, all failing the same assertion in
`views-http.test.ts` ([fixture-regression-first-run-failure.txt](fixture-regression-first-run-failure.txt)).

**The defect was in the test, not in the route.** The supersession proof cloned
and republished the file's *main* period, so under a shuffle it could run before
the tests that assert the main window reads version 1, and left them reading
version 2. It is an order dependence of exactly the kind FAD-15's shuffled
harness exists to expose, and it was invisible in file order — the suite passed
18/18 every time it was run normally.

Fixed by making the test own the state it mutates: it now creates its own period
and its own August window (`current_published_assignments`' D-1b exclusion is
global per membership across periods, so the second published interval has to sit
where the first one does not). Re-run: 93/93, order-independent, every file also
passes alone. Both outputs are filed rather than only the green one.


---

## 9. Second-merger rebase onto `112b8c4` (OPUS-M3-005 merged first)

Serialized merge per packet 32 §6: M3-005 merged first, so this branch rebased
and re-ran the full battery. **One conflict, resolved as pure composition.**

| File | Outcome |
|---|---|
| `apps/web/src/router.tsx` | **CONFLICT** — both packets appended a route block at the same anchor (the shared `/**` above and `});` below). Resolved by keeping **both** blocks in sequence: M3-005's publication tree first (it is on main), then this packet's two staff routes. No line from either side was dropped; `routeTree` carries `myScheduleRoute`, `dailySheetRoute` **and** `publicationRoute.addChildren([...])`. |
| `scripts/gates/request-budget/budgets.json` | auto-merged. Verified: 38 interactions, this packet's 4 and M3-005's 7 all present, **zero duplicate ids**. |
| `packages/contracts/src/schedule/index.ts` | auto-merged. Both barrel exports present — `views.js` (this packet) and `versions.js` (M3-005). |
| everything else | replayed clean across all five commits. |

**No semantic collision.** The two packets touch disjoint routes, contracts,
capability keys and web trees; the only overlap was three additive append points.

Post-rebase battery, all exit 0: check **13/13, 1305 tests / 102 files** ·
red-cases **20/20 proven** · fixture-regression **96/96** · SBX **6/6 PASS,
0 vacuous, 308 readings, 0 wrong-tenant, 44/44 tables** · migration cycle
`0001..0010` **clean** · `views-http` **19 passed** and `views-time` **11
passed** standalone.
