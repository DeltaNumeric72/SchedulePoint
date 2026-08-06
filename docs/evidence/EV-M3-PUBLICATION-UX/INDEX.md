# EV-M3-PUBLICATION-UX — OPUS-M3-005, publication and version-management experience

**Task:** OPUS-M3-005 (doc 32 §10d) · **Branch:** `opus/m3-005-publication-ux` ·
**Base:** `d12d469` (main at issuance) · **Worktree:** `.worktrees/m3-005`

This bundle is the evidence for the publication surface: the HTTP routes over
M3-003's frozen publication module, the review-and-confirm screen with its
graduated friction and retained idempotency key, the published-schedule view,
version history with its immutability rendering, version comparison, the
affected-staff read, forward correction and revert.

---

## 1. What was built, and where it lives

| Deliverable | Files |
| --- | --- |
| Publication HTTP surface (9 routes) | `apps/api/src/http/routes/schedule-publication.route.ts` |
| Wire contracts | `packages/contracts/src/schedule/versions.ts` + one barrel line |
| Publication client | `apps/web/src/publication/api.ts` |
| The retained idempotency key | `apps/web/src/publication/idempotency.ts` |
| Review + confirm (friction, CAS rendering, sign-off) | `apps/web/src/publication/PublicationReviewPage.tsx` |
| Difference rendering (change list + affected staff) | `apps/web/src/publication/DifferenceView.tsx` |
| Version history, forward correction, revert | `apps/web/src/publication/VersionHistoryPage.tsx` |
| Published schedule + publication records | `apps/web/src/publication/PublishedSchedulePage.tsx` |
| Version comparison + affected-staff read | `apps/web/src/publication/VersionComparisonPage.tsx` |
| Frame and navigation | `apps/web/src/publication/PublicationLayout.tsx` |
| Routes | `apps/web/src/router.tsx` (one added block, four routes) |

**No migration.** **No edit to `apps/api/src/schedule/**`** or to any other
frozen module. **No audit-module edit.** **No domain vocabulary added** — every
route declares one of the three EXISTING action keys `schedule.version.edit`
(reads), `schedule.publish` and `schedule.revert`, all under CAP-014.

`server.ts` needed **no** registration line: `apps/api/src/http/routes/index.ts`
auto-discovers every `*.route.ts`, which is why the route-policy gate sees the
nine new routes without anything being wired by hand.

### 1a. Why no new read-action key was proposed

§10d permits a read-action key addition "only if missing". It is not missing:
the authoring surface already reads the grid, the version list and the conflict
list under `schedule.version.edit`; these are the same scheduler reading the same
group's schedule; and doc 08 §6 puts all of it on one row. Minting
`schedule.version.read` would create a key every deployment would have to grant
alongside the first to preserve today's behaviour, and a key nobody can be
without is not an authorization boundary. The staff-facing self-scoped read is a
genuinely different question and is OPUS-M3-006's.

---

## 2. Escalations and disclosed additions

### 2a. ESCALATION — there is no audit read API (§10d anticipated this exactly)

§10d: "publication audit display **where authorized** (if no audit read API
exists, that is an escalation, not an in-packet audit-module edit)."

**There is none.** `apps/api/src/audit/` exports a recorder (`recordAuditEvent`),
a chain verifier (`verifyAuditChain`, `verifyCheckpoints`), a checkpoint writer
and the periodic sweeps. Nothing enumerates or queries `audit_events`, and no
`*.route.ts` in the application reads that table. The `audit.export` capability
key exists in `packages/domain/src/authz/catalogue.ts` and has **no consumer**.

**Not worked around.** No audit-module edit was made and no bespoke
`audit_events` read was added to this packet's route — either would be inventing
an audit read surface outside the module that owns the chain.

**What shipped instead, labelled as what it is.** The publication screen renders
`publication_records` — the publication module's own append-only account of each
publication (D-15d: no UPDATE or DELETE grant exists on it) — showing version,
timestamp, actor and affected count. The on-screen note reads: *"These are the
publication module's own records of each publication of this period — not the
audit chain, which has no read surface in the application yet."* Asserted by
`publication.spec.ts` ("renders the current version read-only, with no control
that writes").

**Recommended owner:** OPUS-M3-008 or a dedicated audit-read packet.

### 2b. DISCLOSED ADDITION — a sign-off route, not named in §10d

`POST .../schedule/versions/:versionId/state` moves a version
`draft → in_review → approved` through the frozen `transitionVersion`.

**Why it was added.** OPUS-M3-004 shipped no transition route and §10d names
none, so **before this existed no version could reach `approved` through any HTTP
surface** and the entire publication flow was unreachable end to end from a
browser, however correct each part was. Doc 07 §2.1 and the frozen service treat
sign-off as part of the publication flow (`transitionVersion` re-checks the same
hard-breach prerequisite the publication transaction re-checks at commit).

**What it is bounded to.** One handler, one existing service function, the
existing `schedule.version.edit` key (not `schedule.publish` — approving a draft
is not publishing it), the `publishing`/`published`/`superseded` transitions
excluded from the wire enum and refused by the frozen service's
`LEGAL_TRANSITIONS` independently. One control on the review screen
(`SignOffPanel`). Removable in one hunk; reassignable to M3-008 if Fable prefers.

### 2c. IMPLEMENTER-ADDED CONTROL — a second compare-and-set over the review

`expectedPriorCurrentVersionId` (FAD-22(2)) answers "did another publication win
this period?". It does **not** answer "did the draft change between the review
and the confirmation?" — a co-author adding or removing an assignment in that
window would be published by a human who confirmed a different set of changes.

So the review carries a `reviewDigest` over the pure difference, the confirmation
echoes it, and a mismatch is `409 STALE_REVIEW` with the current digest and an
explicit re-read. It is the grid's cell-revision pattern one level up. Disclosed
because it is an addition rather than a packet requirement.

---

## 3. The key proofs §10d names, and where each is discharged

| §10d key proof | Where | Falsifiable? |
| --- | --- | --- |
| Publish requires the grant — **deny rendered** | `publication.spec.ts` "GRANT DENY STATE" | the ALLOW arm renders the confirm control |
| Publish requires the grant — **server-denied** | `publication-http.test.ts` "DENY: the same request from a scheduler WITHOUT the grant" | the same body, same route, granted actor → 200 |
| The CAS loser's explicit failure rendered, **naming the version by NUMBER** (review N3) | `publication.spec.ts` "CAS LOSER"; `publication-http.test.ts` "the compare-and-set loser is told which version is current" + "the CAS loser is named by NUMBER as well as by id" | the refusal asserts the version is still `approved` and no record exists; the UI assertion requires the uuid to be **absent** |
| Idempotent replay — double-click | `publication.spec.ts` "a DOUBLE-CLICK issues exactly one publication request" | the control is asserted disabled in flight |
| Idempotent replay — retry-after-timeout | `publication.spec.ts` "a RETRY carries the same idempotency key" | **red case `publish-idempotency-key-retained`** |
| Publishes once, at the server | `publication-http.test.ts` "PUBLISH ONCE"; `publication-concurrency.test.ts` "the SAME key twice, concurrently" | one record, one audit row, one outbox event asserted by count |
| History immutability rendered truthfully | `publication.spec.ts` "IMMUTABILITY: no edit affordance in any immutable row" | **the draft row asserts exactly one `data-affordance="edit"`** |
| Diff display equals the pure-function diff | `publication-diff-parity.test.ts` | **four perturbations asserted to fail** |
| axe / keyboard / 320px / budgets / I-13 | `publication.spec.ts`, `budgets.json` | I-13 budgets are 0 and can never be raised |

### 3a. The deny actor is chosen so the deny can only mean the grant

`groupOnly` holds the **scheduler role in the same group** as the allow actor and
differs in exactly one thing: no `schedule.publish` grant. A deny proved with
`member` would also be proving the role check and would still pass with the
grant-only property broken.

### 3b. The immutability proof, stated precisely

Every history row carries `data-immutable`; every control inside a row declares
`data-affordance` as `edit` (opens THIS version for editing), `read` (compare,
view) or `derive` (creates a NEW version — clone, revert — and never writes to the
row it started from). The assertion is: zero `edit` affordances inside any
`data-immutable="true"` row, **and exactly one inside the draft row**. The second
half is what stops the first from passing vacuously if the attribute were never
emitted or no controls rendered. Asserted at both the table (≥640px) and list
(320px) renderings.

---

## 4. Defects found by running, and fixed

### 4a. Two of them

§4b below is the serious one (a committed `publishing` write). The second — the
review claiming a published version would supersede itself — is recorded at §7b.

### 4b. A publication refused after step 04 was COMMITTED

It stranded the version.

The first version of `withPublication` mapped the frozen service's typed failures
**inside** the unit of work and returned an outcome — the shape
`schedule-authoring.route.ts` uses, which is safe there because every authoring
service function refuses before it writes.

It is not safe here. The publication transaction writes `state = 'publishing'` at
step 04 and only then re-checks its prerequisites at steps 05 (`OPEN_HARD_BREACH`)
and 08 (`CURRENT_VERSION_MOVED`). Returning normally makes `PgUnitOfWorkRunner`
COMMIT, so the `publishing` write survives a refusal — a state only the reconciler
can clear, blocking every later attempt to publish that version.

**How it was found.** Not by reading. The advisory period lock was removed to
measure whether it was load-bearing; with it gone the frozen service's own
compare-and-set fired, and the concurrency test reported the loser's state as
`publishing` rather than `approved`.

**The fix.** The mapping moved outside `runtime.run`, where the only way out of a
failure is a thrown error and a thrown error is a `ROLLBACK`. `publishThrough`
now catches nothing.

**The proof, and its falsification.**
`publication-http.test.ts` → "ROLLBACK: a prerequisite that fails AFTER step 04
leaves the version approved, not publishing" asserts `state='approved'`,
`is_current=false`, `version_number=null`, zero publication records and zero
`schedule.version.published` audit rows. Restoring the inside-the-transaction
catch makes it fail with `Received: "publishing"` — captured in
[`rollback-falsification.txt`](rollback-falsification.txt).

---

## 5. Graduated confirmation friction (SP-E §3), and why it is not decorative

| Situation | Tier | Demanded |
| --- | --- | --- |
| first publication of a period, nobody affected | `acknowledge` | an explicit checkbox |
| supersedes a live version, **or** any affected staff | `type-to-confirm` | the checkbox **and** the period name typed exactly |
| a revert | `type-to-confirm` | the checkbox and `revert <period name>` |

**The tier is computed by a shared contract function** (`publicationFrictionTier`)
and **re-computed by the server inside the publishing transaction** from its own
reading of the world. A client that omitted the phrase is refused with a 422
naming `confirmationPhrase`; a client that asked for more friction than the server
requires is harmless; neither can lower it. Asserted three ways in
`publication-http.test.ts` ("the typed confirmation is enforced by the SERVER"):
omitted → 422, wrong → 422, correct → 200, all on otherwise identical bodies.

The phrase is the **period name** rather than a fixed word: a fixed word is muscle
memory within a week, while the period name cannot be typed without having read
which planning window is about to go live — which is the mistake the friction
exists to catch. The revert phrase is prefixed so a user cannot revert with
something they had typed to publish; `publication.spec.ts` asserts the publish
phrase is refused for a revert.

---

## 6. Screenshots — every state, both viewports

`screenshots/<state>.<project>.png`, 52 files, produced by the real browser
against the real production bundle. `desktop` = 1280×800, `mobile` = 390×844
(Pixel 5); the three `*-320` states set the viewport to 320×640 in both projects.

| State | Files |
| --- | --- |
| loading | `review-loading` |
| empty | `published-empty` |
| error (fixed 5xx text, verbatim) | `review-error` |
| denial (403, "no permission") | `review-denied` |
| grant deny state (readable review, no publish control) | `review-publish-denied` |
| blocked by a hard breach | `review-blocked` |
| the difference | `review-difference` |
| confirmation open / refused | `review-confirm-open`, `review-confirm-refused` |
| published / replay / failed | `review-published`, `review-published-replay`, `review-publish-failed` |
| CAS loser / stale review | `review-cas-moved`, `review-stale-review` |
| keyboard journey | `review-keyboard` |
| a published version does not claim it supersedes itself | `review-already-published` |
| history / clone / revert | `history`, `history-clone-confirm`, `history-clone-created`, `history-revert-confirm`, `history-reverted` |
| published schedule | `published-schedule` |
| comparison | `comparison` |
| 320px | `review-320`, `history-320`, `published-320` |

These are the publication half of the M3 exit's real-browser evidence.

---

## 7. Commands run, with results

Verbatim captures: [`battery.txt`](battery.txt), [`check-output.txt`](check-output.txt),
[`red-cases-output.txt`](red-cases-output.txt),
[`fixture-regression.txt`](fixture-regression.txt),
[`axe-serial-rerun.log`](axe-serial-rerun.log),
[`sbx-summary.txt`](sbx-summary.txt),
[`rollback-falsification.txt`](rollback-falsification.txt).

Every command below was run with `SP_TEST_PREVIEW_PORT=4310` and the worktree's
derived database port **55602** (`scripts/sbx/test-port.mjs`), so neither
collided with the parallel `.worktrees/m3-006`.

| Command | Result |
| --- | --- |
| `corepack pnpm check` (run 1, uncontended) | **13/13 gates PASS** · 1274 unit tests in 100 files · 293 e2e passed, 5 skipped · 33 budgeted interactions, 66 recordings |
| `corepack pnpm check` (run 2, **contended — see §7a**) | 12/13; `axe` FAIL on three timeouts, none of them this packet's |
| `corepack pnpm run gate:axe` (serial re-run) | **295 passed, 5 skipped, exit 0, 2.8 min** |
| `corepack pnpm run gate:request-budget` (on run-2 recordings) | **PASS** — 33 budgeted interactions, 66 recordings |
| `corepack pnpm check` (**run 3 — after the review delta, §7c**) | **13/13 gates PASS, exit 0** · 1275 unit tests in 100 files · 297 e2e passed, 5 skipped · **34** budgeted interactions, 68 recordings |
| `corepack pnpm red-cases` | **19/19 PROVEN**, including the new `publish-idempotency-key-retained` |
| `corepack pnpm fixture-regression` | **94/94 runs passed**, order-independent under every seed tried, every file also passes alone, baseline unmodified |
| `corepack pnpm sbx` | 6 required · 6 executed · **6 passed** · 0 failed · 0 blocked · **0 vacuous** · 0 probe-error; SBX-004 sweep 308 readings, **0 wrong-tenant rows**, 44 of 44 tables observed |
| `pnpm --filter @schedulepoint/api migrate:cycle:embedded` | **MIGRATION CYCLE CLEAN** — `0001..0010` up→down→up→down→up |
| `publication-http.test.ts` standalone | 22 passed |
| `publication-concurrency.test.ts` standalone | 2 passed (12 rounds each) |
| `publication-diff-parity.test.ts` standalone | 5 passed |

Per the standing verification discipline (runbook, from OPUS-M1-004): every file
that adds a proof of a named condition was run **standalone as well as in the
battery**, and both results are reported. The fixture-regression run's per-file
standalone sweep covers all three:

```
PASS  schedule/publication-concurrency.test.ts          3.9s   2 passed (2)
PASS  schedule/publication-diff-parity.test.ts          2.7s   5 passed (5)
PASS  schedule/publication-http.test.ts                 3.5s  22 passed (22)
```

### 7a. The one failing run, and why it is contention rather than code

The second full `check` reported `axe FAIL` after **2,861 seconds** (the gate's
normal cost is ~170 s). Three tests hit the 30-second per-test timeout:

```
[desktop] rule-editors.spec.ts  › RequiresQualification: author → list → edit round trip
[desktop] shell.spec.ts         › keeps the shell within its request budget
[mobile]  schedule.spec.ts      › POPULATED: the grid renders with valid virtualized ARIA
```

**None of the three is this packet's**, and all three had passed minutes earlier.
The cause was measured, not guessed: `lsof` on the competing process tree resolved
its working directory to `/Users/prabashan/Claude/SchedulePoint/.worktrees/m3-006-adv`
— a parallel agent running its own Playwright and vitest suites on the same
machine. This is the runbook's standing diagnosis ("read it as contention, then
re-run serially before concluding anything about the code"), in its CPU rather
than its port form; `SP_TEST_PREVIEW_PORT=4310` and the derived database port
55602 meant there was no resource collision, only starvation.

**Re-run serially once the other worktree's browser run finished: 295 passed, 5
skipped, exit 0, 2.8 minutes** — captured verbatim in
[`axe-serial-rerun.log`](axe-serial-rerun.log). The contended run is retained
rather than discarded, in
[`check-output-run2-contended.txt`](check-output-run2-contended.txt), because a
battery that failed once should be visible to a reviewer with its diagnosis
attached rather than quietly replaced by a greener one.

The e2e count moves 293 → 295 between the runs because the copy fix in §7b added
one test at each viewport.

### 7c. The independent review's delta (N1 and N3)

The independent review returned **no blocking findings**; all eleven claims survived
its probes and both disclosed additions were ratified. Two claim/ledger-accuracy
items were closed before merge.

**N1 — an unbudgeted two-request interaction.** Changing "Compare against" on the
comparison screen fired `/comparison` and `/affected-staff` with no entry in
`budgets.json`, so no gate held the count. Added `publication-change-comparison`
(`maxRequests: 2`), plus the e2e that produces the recording and asserts the two
GETs *individually* rather than only their total — a single request to the wrong
endpoint twice would otherwise satisfy a bare count. **Measured 2 at both
viewports.** The note carries the reasoning the two reads were split under: the
affected set is what a notification fan-out would use, so "who would be told about
this?" must be answerable without first fetching the whole change list.

The page-load pattern the review also observed (three GETs on entering the
comparison screen: comparison, affected-staff, history-for-the-picker) is
deliberately **not** budgeted, because page loads are not budgeted anywhere in this
repository — `shell-initial-load` is the single exception and it exists to bound a
cold start, not an interaction. Recorded here rather than silently omitted.

**N3 — a claim the render did not keep.** The CAS-loser panel's docblock promised it
"names the version"; it printed a raw uuid, which names nothing to the scheduler
being told their publication was refused. Rather than weaken the claim, the render
was made true: the `409` body now carries `currentVersionNumber` beside
`currentVersionId` — the id is what the client compares on, the number is what a
reader needs, and the surface should not have to choose. The panel renders
"Version 1 is current now"; both docblocks (the panel's and the contract's) now say
exactly that.

Asserted on both sides, and in both directions:

- UI — the panel shows the number **and** the assertion requires the uuid to be
  absent, so reverting to the id fails the test rather than passing it quietly;
- API — two arms: `currentVersionNumber: null` when nothing is current, and
  `currentVersionNumber: 1` when a version is, reached by racing a second approved
  version against a stale compare-and-set token.

### 7b. A second defect found by running, and fixed

**The review told a published version it would supersede itself.** After a
publication the review re-reads and `currentVersion` becomes THIS version, so the
summary printed "Publishing this would supersede version 2" about version 2. Third
branch added, and **asserted at both viewports** rather than only written
(`publication.spec.ts` → "a version that IS current does not claim it would
supersede itself"), with `review-already-published.{desktop,mobile}.png` retained.

**Sweep floor unchanged.** This packet adds no table, so SBX-004's floor stays at
the 44 M3-007 raised it to — which is what §10a says a wave-2 packet must do.

---

## 8. Honest limitations

1. **The audit chain is not displayed.** §2a. What is displayed is
   `publication_records`, and the screen says so.
2. **Publication-time HARD-rule re-validation is not performed** (SPEC-05 §6 step
   06). It is M3-008's, the frozen service says so at step 06, and the review's
   blocker list deliberately contains no rule verdict — displaying one would fake
   a capability that does not exist on this branch.
3. **Unmet demand is a WARNING, not a blocker.** Nothing in SPEC-05, doc 07 or the
   publication transaction refuses a publication for a short-staffed date, and
   inventing that refusal would be a business rule this packet has no authority to
   make. A rota is frequently published knowingly short.
4. **`CURRENT_VERSION_MOVED` raised by the frozen service renders with both
   `currentVersionId` and `currentVersionNumber` null**, so the panel falls back to
   "the version that is current now is not the one you reviewed". The route checks
   the same condition under the period lock immediately before, so this branch is
   unreachable in practice; re-reading after a rollback would need a second
   transaction to answer a case that cannot arise. The route-level refusal, which
   is the one users actually meet, names the version by its number (§7c).
7. **Page loads are not budgeted**, here or anywhere in this repository — the sole
   exception is `shell-initial-load`, which bounds a cold start rather than an
   interaction. The comparison screen's three entry GETs are therefore recorded in
   §7c rather than gated. Every *interaction* on this surface is budgeted.
5. **The e2e intercepts the API.** The server's behaviour is proven separately
   over HTTP against the real database. This is the same division every prior UI
   packet records.
6. **Time is formatted in the browser** for display only, always with the group
   zone named beside it. Instants are computed by the server; nothing here writes
   a time.
