# EV-M3-AUTHORING-UX — OPUS-M3-004, scheduler schedule-authoring experience

**Task:** OPUS-M3-004 (doc 32 §10b) · **Branch:** `opus/m3-004-authoring-ux` · **Base:** `d8babbe`

This bundle is the evidence for the scheduler-facing authoring surface: the HTTP
routes over M3-003's frozen service, the period/demand administration screens,
the virtualized grid and its accessible alternative, the cell editor, the
stale-edit compare-and-set, and the twenty-seven remaining rule-node editors.

---

## 1. What was built, and where it lives

| Deliverable | Files |
| --- | --- |
| Authoring HTTP surface (16 routes) | `apps/api/src/http/routes/schedule-authoring.route.ts` |
| Wire contracts | `packages/contracts/src/schedule/authoring.ts` + one barrel line |
| Period administration, demand authoring, draft management | `apps/web/src/schedule/PeriodsPage.tsx` |
| Grid page, validation display, cell-editor host | `apps/web/src/schedule/GridPage.tsx` |
| Virtualized ARIA grid + tabular/list alternative | `apps/web/src/schedule/ScheduleGrid.tsx`, `grid-model.ts` |
| Cell editor (assign/remove/reassign/pin/credit) | `apps/web/src/schedule/CellEditor.tsx` |
| The eligibility ruling, client half | `apps/web/src/schedule/eligibility-offer.ts` |
| Schedule client | `apps/web/src/schedule/api.ts` |
| The 27 remaining rule-node editors (30 total) | `apps/web/src/rules/node-editors.tsx`, `RulesPage.tsx`, `rules/api.ts` |
| Routes | `apps/web/src/router.tsx` (one added block) |

**No migration.** **No edit to `apps/api/src/schedule/**`** or to any other
frozen module. **No domain vocabulary added** — every route declares one of the
two existing action keys `schedule.period.administer` (CAP-019/CAP-020) and
`schedule.version.edit` (CAP-014).

`server.ts` needed **no** registration line: `apps/api/src/http/routes/index.ts`
auto-discovers every `*.route.ts`, which is why the route-policy gate sees the
new routes without anything being wired by hand.

---

## 2. The ruling this packet owns — eligibility absent-vs-empty

**Proposed default (implemented, awaiting Fable ratification).**

The cell editor asks the server who may be assigned. Three answers are possible
and only two of them are the same question:

| Server says | Means | The editor offers |
| --- | --- | --- |
| `eligibilityKnown: false` | the caller cannot see credentials at all | **every** candidate, marked "Eligibility not shown" |
| `eligible: null` on a row | no eligibility row for that member and shift type | that candidate, marked "Eligibility not shown" |
| `eligible: false` | genuinely missing a required credential | that candidate, marked "Missing N credentials", override reason required |

**Absent is never rendered as ineligible.** The reason is not stylistic:
`staffing.qualification_holding.read` is grant-only — no role carries it, which
`SYSTEM_ROLE_CAPABILITIES` shows and the API test asserts — so the *default*
scheduler experience is the absent arm. `qualification_holdings` carries a
capability predicate in its RLS SELECT policy, so a caller without the key sees
no holdings and `listMembershipEligibility` reports every requirement as missing
and every colleague as `eligible: false`. Rendering that as "not qualified"
would state a falsehood about a patient-safety-adjacent fact, produced entirely
by an access-control artefact. The catalogue service already says so from its own
side: its answer "is a report about what the caller can see, not a verdict about
the member".

**Empty is not a block either.** When eligibility is known and nobody qualifies,
the roster is still offered behind an explicit override reason, because this
surface *is* the override and recovery mechanism (non-bypass rule 7, I-05) and
eligibility here is a report rather than an enforcement point. Enforcement
against qualifications belongs to publication-time validation (M3-008 step 06)
and to the M4 engine, each computing with its own credential.

**Reversing the ruling is one edit**, by design and in two named places:

- server: `resolveEligibilityVisibility()` in `schedule-authoring.route.ts` — the
  only place the CAP-058 key is consulted;
- client: `decideEligibilityOffer()` in `eligibility-offer.ts` — the only place
  the three-valued disposition is decided.

Nothing else in either layer reads the distinction.

---

## 3. The compare-and-set (PO-DEC-18) — and why the first version did not work

Every cell mutation and every requirement write carries a revision the caller
believes. The revision is recomputed immediately before the service is called; a
mismatch answers `409 STALE_EDIT` carrying the current revision, and nothing is
written.

### The defect the independent review found (B-1..B-3)

The first version asserted that being in one transaction was sufficient — "the
read and the write are the same transaction, so no third party can land an edit
between them". **That was false.** `PgUnitOfWorkRunner` issues a plain `BEGIN`,
so every unit of work is READ COMMITTED, and an unlocked `SELECT` under READ
COMMITTED gives two concurrent transactions the same pre-state: both find their
token current, and both write. My own tests were **sequential**, so they proved
the comparison happened and nothing about whether it was atomic.

Measured by the reviewer, before the fix:

| Probe | Result |
| --- | --- |
| two requirement PUTs, same `expectedRevision` | **both 200 in 11 of 12 rounds** |
| two adds into one empty cell | loser got **404** (a unique violation mislabelled) |
| a concurrent add and remove | **both 200, both landed** — the silent merge PO-DEC-18 forbids |

### What makes it atomic now

`lockAnchor` takes a transaction-scoped `pg_advisory_xact_lock` on the anchor
being edited — the cell, or the requirement — as the **first statement of the
compare-and-set, before the read**. Competing writers on one anchor serialize:
the second blocks until the first commits, its subsequent read (a fresh READ
COMMITTED snapshot) contains that commit, the revision no longer matches, and it
gets the explicit `409` and the refetch flow.

Four properties, each deliberate:

- **The lock is inside `compareAndSet`/`compareAndSetRequirement`, not in the
  routes.** A caller cannot forget it. The defect was invisible in review
  precisely because every route *looked* correct.
- **The key is tenant-qualified.** Advisory locks are per-database; a
  cross-tenant hash collision costs a brief wait and never correctness.
- **One lock per transaction, taken first** — no lock ordering, so no deadlock.
- **Taken after the authorization verdict**, so an unauthorized caller cannot
  contend for locks.

`advisoryLockKey` hashes in Node rather than calling `hashtextextended`, so it is
testable without a database and cannot silently change meaning across PostgreSQL
versions.

**A constraint collision is now a 409, never a 404.** The frozen service's
select-then-insert surfaced `shifts_unique_in_version` through the generic error
branch, so the loser of an empty-cell add race was told the cell did not exist.

### The falsifiability proof

Before wiring the red case, the two `lockAnchor` calls were removed and the
concurrency suite re-run: **all three tests failed**, reproducing the reviewer's
own words — *"both writers were accepted"*, *"both the add and the remove
landed"*. The `stale-edit-cas` red case now patches exactly those two lines, so
its violation is **atomicity** rather than the comparison; disarming the `!==`
was catchable by a sequential test, which is what missed the defect.

The token is a digest of **content**, not of a timestamp. A `timestamptz` read
back through node-postgres is millisecond-truncated, so two edits inside one
millisecond would digest identically and the second would silently overwrite the
first — the exact merge PO-DEC-18 forbids. `authoring-time.test.ts` asserts the
digest moves on each of the twelve fields a cell mutation can change; a digest
that ignored one would let that concurrent edit through.

The API test does not merely observe the 409: it asserts **the loser's change did
not land**, because a compare-and-set that answered 409 *after* writing is
identical by status code, and that is the defect worth catching.

---

## 4. Validation display — what it is and what it deliberately is not

The grid shows exactly two things:

1. **Recorded conflicts** — rows already in `schedule_conflicts`, rendered as
   they stand;
2. **Incomplete demand** — assignments counted against the period's stated
   requirement. That is arithmetic, not rule execution.

There is no control anywhere on this surface that claims to check a draft against
the scheduling rules, and the page says so in words: *"Scheduling rules are
checked when a version is published, not here."* Compiled HARD-rule evaluation
against version content is M3-008's step 06; displaying it here would fake a
capability this branch cannot deliver. The e2e asserts no such control exists.

---

## 5. Commands run, with results

All commands run in `.worktrees/m3-004`, derived database port **55650**.

### 5.-1 Composed battery — SECOND-MERGER REBASE onto `c3e1baa`

OPUS-M3-007 (group settings and site attribute) merged first. This branch was
rebased onto it as the second merger; the composition is recorded in §9.

| Command | Exit | Composed result |
| --- | --- | --- |
| `corepack pnpm check` | 0 | **13/13 gates**, 97 files, **1245 tests**, e2e **241 passed** |
| `corepack pnpm red-cases` | 0 | **18/18 proven** |
| `corepack pnpm fixture-regression` | 0 | **91/91**, rotating seed **32596**, 863 tests per run |
| `corepack pnpm sbx` | 0 | 308 readings, 0 wrong-tenant, **44 of 44 tables** — 007's `locations` raised the floor from 43 and the composed floor holds |
| migration cycle `0001..0010` | 0 | **CLEAN** — up → down → up → down → up |
| concurrency suite, standalone | 0 | 3/3, 12 rounds each |

Composed counts against the pre-rebase branch: tests 1177 → 1245, files 91 → 97,
e2e 209 → 241, routes 73 → 80, migrations 9 → 10, sweep floor 43 → 44.

### 5.0 Revision battery (after B-1..B-4)

| Command | Exit | Result |
| --- | --- | --- |
| `corepack pnpm check` | 0 | **13/13 gates**, 91 files, **1177 tests**, e2e **209 passed** |
| `corepack pnpm red-cases` | 0 | **18/18 proven** |
| `corepack pnpm fixture-regression` | 0 | **85/85**, rotating seed **982699**, 795 tests per run |
| `corepack pnpm sbx` | 0 | 301 readings, 0 wrong-tenant, 43/43 tables, 0 vacuous |
| concurrency suite, standalone | 0 | 3/3, 12 rounds each |
| `authoring-http` + `authoring-time`, standalone | 0 | 39/39 |

### 5.1 Static gates

| Command | Result |
| --- | --- |
| `corepack pnpm gate:typecheck` | PASS |
| `corepack pnpm gate:lint` | PASS |
| `corepack pnpm gate:build` | PASS |
| `corepack pnpm gate:import-boundary` | PASS — 150 modules, 328 dependencies |
| `corepack pnpm gate:route-policy` | PASS — 73 registered routes |
| `corepack pnpm gate:network-guard` | PASS — 28 source files, 3 built files, allowlist 0 |
| `corepack pnpm gate:rule-node-mapping` | PASS — 30 declared nodes, 30 compiler mappings |
| `corepack pnpm gate:request-budget` | PASS — 17 budgeted interactions, 34 recordings |

### 5.2 Named proofs, run STANDALONE as well as in the battery

The standing verification discipline (runbook, from OPUS-M1-004): a suite that
passes in the full run may still fail alone.

| Proof | Standalone | In battery |
| --- | --- | --- |
| `apps/api/test/schedule/authoring-time.test.ts` | 23/23 | see §5.3 |
| `apps/api/test/schedule/authoring-http.test.ts` | 16/16 | see §5.3 |
| `apps/web/test/node-editors.test.ts` | 64/64 | see §5.3 |
| `apps/web/test/eligibility-offer.test.ts` | 11/11 | see §5.3 |

### 5.3 Full battery

Verbatim captures in `battery.txt` beside this file.

| Command | Result |
| --- | --- |
| `corepack pnpm check` | **13 gate(s): 13 passed, 0 failed** — 90 test files, **1174 tests**, e2e 193 passed |
| `corepack pnpm red-cases` | **18 case(s): 18 proven, 0 not proven** — including the two added here |
| `corepack pnpm fixture-regression` | **84 run(s): 84 passed, 0 failed** — 14 fixed seeds + rotating seed **995888**, 792 tests per run; order-independent under every seed; every file also passes alone |
| `corepack pnpm sbx` | 6 scenarios; SBX-004 **301 readings, 0 wrong-tenant rows, 43 of 43 tenant tables observed with visible rows**; **0 vacuous assertions**; audit chain 0 problems |

The fixture-regression per-file standalone sweep re-confirms both new API proofs
alone — "Every file also passes alone" — which is the standing verification
discipline (runbook, from OPUS-M1-004) satisfied by the battery itself as well as
by the direct standalone runs in §5.2.

**The two new red cases:**

| Case | Violation | Verdict |
| --- | --- | --- |
| `i13-schedule-authoring` | the "New period" control issues a request when clicked | GREEN pass / RED fail — **PROVEN** |
| `stale-edit-cas` | the advisory lock removed, leaving the compare-and-set read unserialized | GREEN pass / RED fail — **PROVEN** |

**The three concurrency probes** (`authoring-concurrency.test.ts`), 12 rounds
each, headers and payloads pre-resolved before `Promise.all` so the requests
genuinely overlap, and the decisive assertion on the **database** — "one 200 and
one 409" is necessary and not sufficient, since a CAS that answered 409 after
writing would satisfy it:

| Probe | Result |
| --- | --- |
| B-1 requirement race | 12/12 one 200 + one 409 `STALE_EDIT`; stored value == the winner's |
| B-2 empty-cell add race | 12/12 one 200 + one 409 `STALE_EDIT` with a refetch revision; exactly 1 assignment |
| B-3 add/remove race | 12/12 one 200 + one 409; no merged state in any round |

Both winner orders occur across the rounds, so the race is real rather than
accidentally serialized.

### 5.4 Browser evidence

`screenshots/` — 37 PNGs at both viewports plus the 320px captures, produced by
the real browser against the real production bundle:

| State | Files |
| --- | --- |
| loading | `periods-loading.*` |
| empty | `periods-empty.*` |
| error / not found | `periods-not-found.*` |
| permission denied | `periods-denied.*` |
| validation failure | `periods-validation.*` |
| populated | `periods-populated.*`, `grid-populated.*` |
| I-13 form open | `periods-form.*` |
| stale edit refused | `requirements-stale.*`, `cell-stale-edit.*` |
| grid alternatives | `grid-table-alternative.desktop`, `grid-list-alternative.mobile` |
| keyboard journey | `grid-keyboard.*` |
| published read-only | `grid-published-readonly.*` |
| cell editor | `cell-editor.*`, `cell-assign-picker.*` |
| the eligibility ruling, both arms | `cell-eligibility-absent.*`, `cell-eligibility-none.*` |
| 320px reflow | `grid-320px.mobile`, `periods-320px.mobile` |

---

## 6. Defects this task found by running, not by reading

1. **142px of page overflow at 320px** on the grid page. A six-column table does
   not fit, and `min-width:auto` on flex children let it push the whole page
   wide. Fixed at both ends: `min-w-0` on the flex columns, and the tabular
   alternative now becomes a **list** below 640px — the same move the rules and
   catalogue surfaces already made, for the same measured reason. Measured 0
   afterwards.
2. **A numeric rule parameter opened blank**, so a freshly opened rule form was
   refused by its own outgoing contract parse before the author had touched it.
   Caught by three **pre-existing** `rules.spec.ts` tests, which were left
   untouched; `initialState` now opens `int`/`decimal` fields at 1.
3. **`schedule_periods.status`, not `state`.** The first contract named the
   column wrongly and the typecheck caught it before any test ran.
4. **A stale bundle.** `gate:axe` runs `vite preview` against `dist`, so two e2e
   runs measured code that had already been fixed. The red-case runner's axe case
   carries `prepare: [gate:build]` for exactly this reason. Recorded because it
   cost two full e2e cycles to rediscover.

---

## 7. Deviations, limitations and carried items

1. **`apps/web/test/**` is a small glob extension.** The packet's allowed web
   globs name `apps/web/src/schedule/**`, `apps/web/src/rules/**` and
   `apps/web/e2e/**`. Two vitest files were added under the existing
   `apps/web/test/` root (`node-editors.test.ts`, `eligibility-offer.test.ts`)
   because both subjects are pure functions and a Playwright file cannot run
   them. Test-only; no production surface. Disclosed for ratification.
2. **The candidate read is N+1 in the number of active members.** The route calls
   the shipped `listMembershipEligibility` once per candidate rather than writing
   a second holdings query, because
   `loader-is-the-only-selector.test.ts` makes `profiles/in-force-loader.ts` the
   only module permitted to select from `qualification_holdings` — and a second
   selection rule is the S-01 defect class. One HTTP request per user action is
   preserved (I-10); the query count is not optimised. An efficient set-based
   read belongs with the M4 engine, which needs the same answer at scale.
3. **Member identity is `users.display_name`.** Migration 0001 makes it readable
   to any context in the same organization through membership — an existing,
   deliberate boundary, not one this packet opens. No email, no credential, and
   nothing patient-related reaches the wire.
4. **Reference parameters other than the shift type are text inputs.**
   Qualification key, staff group, valid-combination, template, request type and
   assignment identity have vocabularies owned by surfaces that are not all
   built; a picker over a list this page cannot fetch would be a guess about what
   the identifier means. Named in the help text instead.
5. **Version lifecycle transitions and lock/unlock are not on this surface.**
   `transitionVersion` and `setLockState` exist in the service; moving a draft to
   `in_review`/`approved` is the publication experience's step, and M3-005 owns
   it. Recorded so it is a sequencing decision rather than an omission.
6. **The eligibility ruling is a proposal.** Implemented as the default described
   in §2 and behind the two named functions; it is not ratified until Fable rules
   on it. Its required-reason arm is now **enforced**, not merely rendered:
   `overrideReasonRequired` refuses an assignment with no reason when the
   caller-scoped eligibility for that member × shift type is `eligible: false`,
   and demands nothing when eligibility is absent or unknown.
7. **The period-length bound has no database half.** `MAX_PERIOD_DAYS = 366` is
   enforced by the contract with an explicit 422, and `datesBetween` now throws
   rather than silently truncating a rota in both renderings. A `CHECK` on
   `schedule_periods` needs a migration and this packet has none; **recorded so
   the constraint lands with a future migration packet.**
8. **Advisory locks are per-database, not per-tenant.** The key is
   tenant-qualified so a collision is a brief wait rather than a correctness
   problem, but a future packet adding heavy concurrent authoring should measure
   contention rather than assume it.

---

## 8. Non-bypass rules touched, and how

| Rule | How this task stands with it |
| --- | --- |
| 1 — never bypass the unit of work | every read and write is inside `runtime.run`; the CAS read and the mutation are the same transaction |
| 4 — never skip entitlement or capability checks | every route declares a policy (gate: 73 routes); the service re-evaluates the same key inside the transaction; allow AND deny asserted for both keys |
| 5 — never mutate a published version | the service refuses and D-15a refuses independently; asserted over HTTP (409) and rendered read-only with no editing affordance |
| 6 — never write audit rows outside the chain | **this packet writes no audit row.** Every audit row comes from the frozen service. The earlier claim "exactly one per mutation" was wrong and is corrected: an assignment carrying an override reason emits **two** — `schedule.assignment.added` and `schedule.assignment.overridden` — which is the service's design, not a defect. The test asserts every name emitted is in `AUDIT_EVENT_NAMES` |
| 7 — never treat manual scheduling as the production mechanism | stated on the screen, not only in a docblock; no fill/generate/suggest control exists anywhere in the diff |
| 9 — never log delivery material or payload bodies | override and removal reason TEXT never reaches a response body (asserted) and never enters an audit payload |
| 10 — never weaken or skip accessibility tests | three pre-existing `rules.spec.ts` tests caught a regression and were fixed in the product, not relaxed; axe runs with `best-practice` included on every new state |
| 11 — never expand capability scope | no capability added; no action key added |
| 13 — never remove or renumber a stable ID | the rule key is `readOnly` when editing, and the edit round trip asserts it |


---

## 9. Second-merger rebase onto `c3e1baa` (OPUS-M3-007 merged first)

`git rebase c3e1baa` replayed nine commits. **One conflict, purely additive.**

### The single conflict hunk — `apps/web/src/router.tsx`

Both packets appended a sibling subtree to the same `routeTree.addChildren([…])`
array, so git could not order two adjacent insertions at the same anchor.

```
<<<<<<< HEAD                                   (c3e1baa — OPUS-M3-007)
  settingsRoute.addChildren([settingsGroupRoute, settingsLocationsRoute]),
=======                                        (70a1586 — OPUS-M3-004)
  scheduleRoute.addChildren([schedulePeriodsRoute, scheduleVersionRoute]),
>>>>>>> 70a1586
```

Composed result — **both lines kept, neither modified**:

```
  settingsRoute.addChildren([settingsGroupRoute, settingsLocationsRoute]),
  scheduleRoute.addChildren([schedulePeriodsRoute, scheduleVersionRoute]),
```

Nothing else in the file conflicted: both import blocks and both route
declarations merged cleanly, and the composed router registers both trees.

### Files that did NOT conflict, and why that is worth stating

- **`scripts/gates/request-budget/budgets.json`** — both packets added rows and
  git merged them without a marker, because the insertions landed at different
  anchors in the array. Verified by content rather than by the absence of a
  conflict: **27 interactions** = 8 pre-existing + 3 from OPUS-M3-002 + **12
  from this packet** + **4 from OPUS-M3-007**, all present.
- **`packages/contracts/src/index.ts`** — 007's only; this packet touched
  `src/schedule/index.ts`, a different file.
- **Migrations** — no renumbering needed: this packet has none, and `0010` is
  theirs.

### The one expected transient

Immediately after the rebase, `gate:request-budget` failed with four violations —
`settings-open-new-location`, `settings-save-location-accepted`,
`settings-save-timezone-accepted`, `settings-save-timezone-refused` — each *"no
recording for budgeted interaction"*. Recordings are gitignored run artifacts, so
007's had never been produced in this worktree. `pnpm check` runs the e2e gate
(which now includes their `settings.spec.ts`) before the budget gate, and the
composed run passes 13/13 with all 27 interactions measured. This is the gate's
"a missing measurement is a failure, not a skip" rule behaving correctly, not a
composition defect.
