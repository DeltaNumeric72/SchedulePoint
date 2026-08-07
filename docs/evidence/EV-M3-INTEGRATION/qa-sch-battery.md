# QA-SCH manual-path battery — executed and filed

**OPUS-M3-008 · research report 11 §QA-SCH-001..016 · doc 15 testing strategy**

The packet asks for *"the applicable QA-SCH manual-path battery executed against
the composed system"*, filed **per case as pass / fail / not-applicable-with-
reason**. This is that filing.

## How "executed" is meant here

Every `PASS` below names the file and the assertion that carries it. A case is
marked `PASS` only where a test in this repository exercises the composed system
and would fail if the behaviour regressed. Where a case's expectation is
partially satisfied, it says which part and why the rest is not claimed — the
distinction between "we do this" and "we do some of this" is the whole value of
the filing.

**Nothing below is marked PASS on the strength of a design intention.** Several
cases are `NOT APPLICABLE (M4)` or `NOT APPLICABLE (M5/M9)` because the path they
test does not exist yet; each names its owning milestone rather than being
dropped (non-bypass rule 11).

---

| # | Case | Result | Evidence, or the reason |
|---|---|---|---|
| **QA-SCH-001** | Publishing an incomplete schedule | **PARTIAL PASS** | Unmet demand is computed and surfaced as a **warning**, not a blocker, and the surface says so: `computeWarnings` in `schedule-publication.route.ts` counts requirements against filled cells, and `PUBLICATION_WARNING_CODES.UNMET_REQUIREMENT` renders on the review page (`apps/web/e2e/publication.spec.ts`). **The acknowledgement half is not claimed**: the case expects an acknowledgement *listing every unfilled mandatory shift, recorded in the audit trail*. The graduated type-to-confirm friction (M3-005) is audited as a publication, but the friction is not scoped to the coverage gap. **Owner: M4** — the acknowledgement is meaningful once coverage is computed by the engine that fills it; scoping the friction to a coverage gap before then would be a business rule this packet has no authority to invent, which M3-005 already recorded. Surfaced at M3 exit for the owner's awareness, but the milestone that closes it is M4 |
| **QA-SCH-002** | Publication prerequisites explicit and **re-checked at commit** | **PASS** | This is the case OPUS-M3-008 exists to close. SPEC-05 §6 re-checks **four** prerequisites inside the publication transaction, after the caller decided to publish: step 03 version state, step 05 open hard-breach conflicts, **step 06 HARD-rule re-validation (new)**, step 08 the prior-current compare-and-set. `apps/api/test/schedule/step-06-hard-rules.test.ts` proves the step-06 half both ways — refused with the rule active, published with it `disabled` — and proves the refusal **rolls back** (`versionState` is still `approved`, `current_published_assignments` empty). "Refuses, not merely warns" is exactly what the case demands |
| **QA-SCH-003** | Overlapping assignments for one person | **PASS** | D-1a (`assignment_snapshots` version-scoped `EXCLUDE`) and D-1b (`current_published_assignments` global `EXCLUDE`) at the database, across midnight, proven at M3-003 (`v-harness.test.ts`, V-01/V-03/V-13). Boundary-touching intervals are allowed — `tstzrange` is `[)`, so 08:00–16:00 and 16:00–22:00 do not overlap, which the fixture relies on. **Rest is a separate rule and is now step 06's** (`MinimumRestBetween`), which is the case's "unless a rest rule says otherwise" half |
| **QA-SCH-004** | Overnight shift spanning midnight | **PASS** | M3-006: a 22:00→06:00 shift renders on both days, labelled differently, including across a DST boundary (`apps/api/test/schedule/views-time.test.ts`, `apps/web/e2e/my-schedule.spec.ts`). D-1a's exclusion covers the midnight case. Step 06's `MinimumRestBetween` reads instants, not dates, so an overnight shift is measured across the boundary rather than by calendar day |
| **QA-SCH-005** | Rest-period and maximum-hours violations | **PARTIAL PASS** | **The manual path is now checked at publication**: `MinimumRestBetween`, `MaxConsecutive` and `MaxAssignmentsInWindow` are three of the six EVALUATED kinds, and a version breaching any of them cannot be published (`step-06-hard-rules.test.ts`, and the per-kind boundary tests in `packages/domain/test/rules/hard-rule-check.test.ts` — passes at exactly the minimum, breaches one minute under). **What is not claimed**: the case says "every path evaluates the same rule engine", and the claim, swap and generator paths do not exist yet (M4, M5, M8). The engine they will share is the one built here — `evaluateHardRules` is a pure function over content, deliberately callable from anywhere |
| **QA-SCH-006** | Qualification / eligibility conflict | **PARTIAL PASS** (PASS at publication; deliberately not blocking at authoring) | `RequiresQualification` is EVALUATED at step 06 with expiry against the **assignment date**, and a version assigning an uncredentialed member cannot be published — proven, with the falsification driven by *renewing the credential* rather than by disabling the rule (`step-06-hard-rules.test.ts`). Authoring shows eligibility three-state under FAD-23 and does **not** block, deliberately: the authoring surface IS the override/recovery mechanism (rule 7), and FAD-23 rules that an absent eligibility read must never render as "not qualified". The case's "blocked on every path" is therefore satisfied at the gate that matters and honestly not at the override surface. **Owner of the remaining paths: M4/M5/M8**, as for QA-SCH-005 |
| **QA-SCH-007** | Duplicate shift definitions and duplicate assignments | **PASS** | Unique constraints at the **database**, not in the UI: `shift_types` code uniqueness per group (0005), D-14 `(version_id, assignment_identity_id)` (0009). Idempotent publication is D-17 with a client-retained key — a double-click and a retry-after-timeout each publish once, proven in the browser (`apps/web/e2e/publication.spec.ts`, "publish once") and at the service (`publication-invariants.test.ts`) |
| **QA-SCH-008** | Concurrent editing of the same schedule cell | **PASS** | M3-004's B-1 finding and its fix: `compareAndSet` takes `pg_advisory_xact_lock` INSIDE the compare, and three 12-round race tests assert **database state**, not just status codes (`apps/api/test/schedule/authoring-concurrency.test.ts`). The loser is refused explicitly and re-fetches; nothing is merged. The case's "B is shown A's new value" is satisfied by the 409-class re-read |
| **QA-SCH-009** | Concurrent publication of the same period | **PASS** | Serialised by the step-02 period lock; the loser fails explicitly at step 03 or at the FAD-22(2) required compare-and-set; **exactly one outbox event** per publication. Proven at the service (`publication-concurrency.test.ts`) and re-proven through the real HTTP routes on the composed system (`apps/api/test/schedule/composed-integration.test.ts` §concurrency). Different periods do not contend (V-15b) |
| **QA-SCH-010** | Publication succeeds but notification dispatch fails | **PARTIAL PASS** | I-11 proven from **both** sides at M3-003 (`publication-invariants.test.ts`): an outbox WRITE failure rolls the publication back atomically, and a delivery failure after commit never unwinds it. Dispatch is a separately retried job with durable idempotency (`outbox_effects`, FAD-14 C-4). **Not claimed**: the case also wants an admin-visible "published, notifications pending/failed" surface. There is no delivery-status UI. **Owner: the notification-delivery milestone** (SPEC-07), which owns the adapters that would populate it |
| **QA-SCH-011** | Post-publication editing and rollback / unpublish | **PASS** | Forward-only correction: clone → amend → publish, with `schedule.revert` a **separate grant** from `schedule.publish` and its own audit event. No mutation path to a published row exists in the API, and D-15a/b/c would refuse one anyway. The UI renders no edit affordance on a published or superseded version (DOM-asserted, M3-005). Affected-staff differences are computed per membership so re-notification is targeted, not broadcast |
| **QA-SCH-012** | Published history preserved immutably | **PASS** | D-15a/b/c triggers with FAD-22's INSERT extension, the complete V-01..V-19 harness (23 rows), byte-identity of published history by sha256 per row, and `version_supersessions` append-only. "What was published as of T" is answerable because every version is retained and `is_current` is a partial unique index rather than a rewrite |
| **QA-SCH-013** | Inactive / archived staff and archived shift types referenced by a schedule | **PARTIAL PASS** | Archive-not-delete is enforced at the database for shift types, qualifications and rules — `app_guard_rule_delete`, `app_guard_qualification_delete`, and no `DELETE` grant on `shift_type_qualifications` for any runtime role **or the owner**. Historical views render an archived shift type by code (`withShiftTypeCodes` returns `?` only when the row is genuinely gone). **Not claimed**: an explicit "archived" marker on a historical schedule cell is not implemented. **Owner: M6** (administrative completeness), the milestone that owns the remaining history-display work |
| **QA-SCH-014** | Large schedule and long-name rendering | **PARTIAL PASS** | M3-004 ships the virtualized grid **and** a first-class accessible tabular alternative, with the reviewer's stronger full-sweep equality proof (both render the same data). 320px reflow and ≥44px targets are asserted at both viewports across every surface. **Not claimed**: the ≥200-staff × 8-week PERF fixture and interaction-latency measurement have not been run — that is the `PERF` environment, which does not exist in this milestone. **Owner: the performance milestone** (the `PERF` environment, EV-8 class); the case is not dropped |
| **QA-SCH-015** | Every schedule mutation is attributably audited | **PASS, and now READABLE** | Every mutation on every path writes through the one chain API in the **same unit of work** as the mutation (FAD-12), with actor, subject, mechanism and before/after; the chain verifies clean after every suite run. What M3-005 could not do was let anyone *read* it — there was no read surface. OPUS-M3-008 adds it (`apps/api/src/audit/reader.ts`, `audit.route.ts`), capability-gated, and the publication surface now renders the chain beside the publication records with each labelled as what it is. The case's "entries are human-readable and immutable" is satisfied on both halves for the first time |
| **QA-SCH-016** | Destructive bulk operations gated proportionally to blast radius | **NOT APPLICABLE at M3 — no destructive bulk operation exists** | There is no `Erase Master Schedule`, no batch delete, and no bulk assignment path in this system. The pattern the case asks to adopt is already in place where a wide action does exist: publication and revert both use graduated type-to-confirm friction naming the exact scope, with a dry-run preview (the difference view) that the source lacked (M3-005). Owner when a bulk path lands: the milestone that introduces it |

---

## Summary

| Result | Count | Cases |
|---|---|---|
| PASS | 9 | 002, 003, 004, 007, 008, 009, 011, 012, 015 |
| PARTIAL PASS — the unclaimed half named, with an owning milestone | 6 | 001 (M4), 005 (M4/M5/M8), 006 (M4/M5/M8), 010 (notification delivery), 013 (M6), 014 (performance) |
| NOT APPLICABLE, with reason and owner | 1 | 016 (the milestone that introduces a bulk path) |
| **Total** | **16** | QA-SCH-001..016 |

*(The first version of this table said PASS 9 and listed 10, said PARTIAL 6 and
listed 5, and counted QA-SCH-010 in both — the counts were written before the
rows settled and then not re-read. Each PARTIAL now names an owning milestone
rather than "the M3 exit report", which is a document and not an owner.)*

The single most consequential movement in this milestone is **QA-SCH-002 and
QA-SCH-005/006**: before step 06, a manually authored schedule could be published
without any rule being evaluated against it at all. That is now impossible for
the six EVALUATED kinds, and impossible to do *silently* for the other
twenty-four — an unevaluable HARD rule blocks and names itself
(`step-06-node-kinds.md`).
