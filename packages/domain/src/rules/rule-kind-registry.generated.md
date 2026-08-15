<!-- GENERATED FILE — do not edit by hand.
     Source: packages/domain/src/rules/registry.ts (+ ast.ts, hard-rule-check.ts).
     Regenerate: corepack pnpm gate:rule-kind-registry --write
     The `rule-kind-registry` gate fails the build if these bytes drift. -->

# The rule-kind registry (generated)

Generated from the closed AST source — `RULE_NODE_KINDS`, `EVALUATED_HARD_RULE_KINDS`, `NOT_EVALUABLE_REASONS` and `RULE_KIND_METADATA`. Every count below is computed, not typed. OPUS-M4-000C, doc 34 §4-D.

## Counts

| Measure | Value |
|---|---|
| Unique node kinds | 30 |
| EVALUATED by the independent checker | 22 |
| NOT-EVALUABLE | 8 |
| Evaluated + not-evaluable | 30 (must equal the unique count; the two sets are disjoint) |
| Still ONE OPEN owner ruling away, nothing else needed | 0 |
| Awaiting input a named later milestone owns | 4 |
| Distinct rulings cited (open + ruled) | 11 |

### By not-evaluable class

| Class | Kinds |
|---|---|
| `grouping-unit-not-pinned` | 0 |
| `semantics-not-pinned` | 0 |
| `identifier-domain-not-pinned` | 0 |
| `constrains-the-search-not-the-content` | 0 |
| `data-not-modelled-at-m3` | 4 |
| `classification-contradiction` | 4 |

### By family

| Family | Kinds |
|---|---|
| `coverage` | 3 |
| `eligibility` | 4 |
| `capacity` | 4 |
| `rest-and-spacing` | 4 |
| `pattern` | 3 |
| `linkage` | 3 |
| `preference` | 3 |
| `fairness` | 2 |
| `locum` | 2 |
| `fixed` | 2 |

## Every kind

| Kind | Family | Natural | Evaluated | Class | Required input | Semantics / pending ruling | Evaluation owner | Milestone owner |
|---|---|---|---|---|---|---|---|---|
| `RequiredCount` | coverage | hard | yes | — | assignment_snapshots; shifts; schedule_requirements | RK-RULING-01: exactly `count` scoped assignments on EVERY (date, shift type) pair the scope admits within the accounting window — including pairs with none, which is the case a row-walking checker cannot see. | solver-and-validator | M4-002 |
| `MinCoverage` | coverage | hard | yes | — | assignment_snapshots; shifts; schedule_requirements | RK-RULING-01: at least `min` scoped assignments per (date, shift type). As RequiredCount. | solver-and-validator | M4-002 |
| `MaxCoverage` | coverage | hard | yes | — | assignment_snapshots; shifts; schedule_requirements | RK-RULING-01: at most `max` scoped assignments per (date, shift type). As RequiredCount. | solver-and-validator | M4-002 |
| `RequiresQualification` | eligibility | hard | yes | — | qualification_holdings; qualifications.key → id (snapshot v2 vocabulary); qualifications.status; assignment_snapshots.date | Every scoped active assignment’s assignee held the named qualification, valid at the assignment’s date. validAt is a fixed literal shift_date in the AST. | independent-checker | M3-008 |
| `MemberOfStaffGroup` | eligibility | hard | yes | — | staff_groups.id; staff_group_members (snapshot v2) | RK-RULING-02: every scoped assignment’s assignee is a member of the named `staff_groups.id`. An unknown id is not-evaluable, never “nobody is in it” — that reading would turn a typo into a breach of every row. | solver-and-validator | M4-002 |
| `ValidGroupRestriction` | eligibility | hard | yes | — | valid_groups.id; valid_group_shift_types (snapshot v2) | RK-RULING-03: no scoped assignment is on a shift type the named `valid_groups.id` does not admit (`valid_group_shift_types`). | solver-and-validator | M4-002 |
| `PickPositionRestriction` | eligibility | hard | yes | — | assignment_snapshots.pick_position | RK-RULING-04: a real pick position outside `allowedPickPositions` breaches; a NULL one satisfies VACUOUSLY. An ABSENT column is neither — it makes the rule not-evaluable. | solver-and-validator | M4-002 |
| `MaxAssignmentsInWindow` | capacity | hard | yes | — | assignment_snapshots.date | Per membership, no ROLLING window of windowDays consecutive dates contains more than max scoped assignments. The node carries no anchor and no alignment field, so a calendar-aligned window would have to invent one. | independent-checker | M3-008 |
| `WeekdayFteLimit` | capacity | hard | yes | — | membership_weekday_fte.fte_fraction; membership_work_profiles | RK-RULING-05 (authored by M4-002): per weekday over the accounting window, count ≤ min(⌈node.fteFraction × N(w)⌉, ⌈profile.fteFraction(w) × N(w)⌉, profile.maxAssignments(w)) over the present terms. MIN, because SPEC-04 §3.3 admits no path that relaxes a HARD rule. | solver-and-validator | M4-002 |
| `WorkPercentageTarget` | capacity | soft | no | classification-contradiction | membership_work_profiles.work_percentage | RK-RULING-06 (authored by M4-002): a TARGET, never a bound. SOFT objective term penalising \|achieved − target\| in assignment units. A HARD authoring is a classification contradiction with no defined breach and blocks fail-closed. | solver-and-validator | M4-002 |
| `MaxConsecutive` | capacity | hard | yes | — | assignment_snapshots.date | Per membership, no run of more than maxDays CONSECUTIVE CALENDAR DATES carries a scoped assignment. Two assignments on one date are one day. | independent-checker | M3-008 |
| `MinimumRestBetween` | rest-and-spacing | hard | yes | — | assignment_snapshots.starts_at; assignment_snapshots.ends_at | Per membership, the gap from one assignment’s ends_at to the next’s starts_at is at least minHours. | independent-checker | M3-008 |
| `CallSpacing` | rest-and-spacing | hard | yes | — | assignment_snapshots.date; shift_types.is_on_call | Per membership, consecutive ON-CALL assignments are at least minDaysBetweenCalls calendar days apart; non-call shifts are ignored. shift_types.is_on_call (migration 0005) is the one attribute that says a shift is a call. | independent-checker | M3-008 |
| `NoAdjacent` | rest-and-spacing | hard | yes | — | assignment_snapshots.date; shift_types.code | RK-RULING-07: the pair may not fall on consecutive calendar dates for one membership, in EITHER order. Instant-gap semantics belong to MinimumRestBetween alone. | solver-and-validator | M4-002 |
| `ForbiddenSequence` | rest-and-spacing | hard | yes | — | assignment_snapshots.date; shift_types.code | RK-RULING-08: the named sequence matched over consecutive calendar dates, in order; an intervening scoped assignment or a gap day breaks the run. | solver-and-validator | M4-002 |
| `PatternRule` | pattern | either | yes | — | shifts; shift_types.code; group_holidays | Constrains the SEARCH, not the content: against a finished version a pattern prescribes what a build assigns, and that reason STANDS. Against a CANDIDATE the question is different and answerable as an implication (M4-002, FAD-38(5)): trigger on a listed weekday ⇒ every segment assigned to the same membership at its offset, where the offset falls inside the build horizon. | solver-and-validator | M4-002 |
| `AlternatingWeek` | pattern | either | yes | — | shifts; shift_types.code | Constrains the SEARCH, not the content: reason STANDS. Against a candidate (M4-002, FAD-38(5)): a membership’s `onShiftType` assignments fall in ONE week class modulo cycleWeeks, counted from the accounting window’s first date because the node carries no anchor. | solver-and-validator | M4-002 |
| `TemplateAdherence` | pattern | either | no | data-not-modelled-at-m3 | assignment_templates (does not exist — doc 06 §3.2) | data-not-modelled-at-m3: `assignment_templates` does not exist yet (doc 06 §3.2). OWNER: templates-slice | awaiting-input | templates-slice |
| `LinkedShifts` | linkage | hard | yes | — | assignment_snapshots; shift_types.code | RK-RULING-09: same membership, same calendar date — a membership holding ANY of the named types on a date holds ALL of them. | solver-and-validator | M4-002 |
| `ImpliesAssignment` | linkage | hard | yes | — | assignment_snapshots; shift_types.code | RK-RULING-09: same membership, same calendar date — `ifShiftType` on a date requires `thenShiftType` on that date. | solver-and-validator | M4-002 |
| `MutuallyExclusive` | linkage | hard | yes | — | assignment_snapshots; shift_types.code | RK-RULING-09: at most one of the named types per membership per calendar date. Exclusive over a single date; wider windows go through scope.dateRange. | solver-and-validator | M4-002 |
| `RequestHonoured` | preference | soft | no | data-not-modelled-at-m3 | the request lifecycle (SPEC-08) — M5, not modelled | data-not-modelled-at-m3: the request lifecycle is M5 (SPEC-08). OWNER: M5-requests | awaiting-input | M5-requests |
| `ShiftPreference` | preference | soft | no | classification-contradiction | assignment_snapshots; shift_types.code | Constrains the SEARCH, not the content: a preference is a ranking, not a bound. It compiles to an objective term in M4-002. | solver-and-validator | M4-002 |
| `AvoidDate` | preference | either | yes | — | assignment_snapshots.date | No scoped assignment STARTS on the named date. RK-RULING-11 ruled start-date attribution STANDS; the question is answered, not open. _(open: **RK-RULING-11**)_ | independent-checker | M3-008 |
| `FairnessBalance` | fairness | soft | no | classification-contradiction | assignment_snapshots; credits; membership_work_profiles | Constrains the SEARCH, not the content: a balance metric has no pinned threshold to breach. It becomes an objective tier in M4-004. | solver-and-validator | M4-002 |
| `CreditDistribution` | fairness | soft | no | classification-contradiction | credits | Constrains the SEARCH, not the content: as FairnessBalance. | solver-and-validator | M4-002 |
| `StaffOverLocumPriority` | locum | soft | no | data-not-modelled-at-m3 | a membership attribute distinguishing a locum — none exists (doc 06 §3.2) | data-not-modelled-at-m3: no membership attribute distinguishes a locum for PRIORITY purposes — `memberships.staffing_kind` says what somebody IS, not the window a priority rule ranks over (doc 06 §3.2). OWNER: locum-slice | awaiting-input | locum-slice |
| `LocumRestriction` | locum | hard | no | data-not-modelled-at-m3 | a membership attribute distinguishing a locum — none exists (doc 06 §3.2) | data-not-modelled-at-m3: as StaffOverLocumPriority. OWNER: locum-slice | awaiting-input | locum-slice |
| `FixedAssignment` | fixed | hard | yes | — | assignment_identities.id; the build’s fixed inputs (snapshot fixedAssignments) | RK-RULING-10: `assignment_identities.id`. The named identity appears in the candidate with the membership, date and shift type it was fixed at. Snapshot v2 carries it — no schema change. | solver-and-validator | M4-002 |
| `ProtectedRange` | fixed | hard | yes | — | assignment_snapshots.date | Constrains the SEARCH, not the content: reason STANDS. Against a candidate (M4-002, FAD-38(5)): every fixed input dated inside the range appears in the candidate unchanged — the fixed inputs are what make “changed” decidable (SPEC-04 §6: recorded rather than inferred). | solver-and-validator | M4-002 |

## The ruling register

Stable ids, never renumbered and never deleted (non-bypass rule 13). A ruling that has been answered keeps its id and carries its answer; only the ones still reading OPEN count towards "one ruling away".

| Id | State | Kinds | Question | Ruling / also needs |
|---|---|---|---|---|
| `RK-RULING-01` | RULED | `MaxCoverage`, `MinCoverage`, `RequiredCount` | What is the grouping unit a coverage count counts over — a shifts row within the version, a date, a date × shift type, or a date × shift type × location? | RULED (doc 35 §6d): date × shift type within the version — the demand model’s own unit (FAD-16 weekday defaults; period requirements per shift type). Location is NOT a coverage dimension in M4 (R-B6: display metadata; a shift without one is legal); a per-location dimension would be a demand-model schema change, recorded as a future owner question. |
| `RK-RULING-02` | RULED | `MemberOfStaffGroup` | What identifier domain does RuleScope/MemberOfStaffGroup.staffGroup name — staff_groups.name or staff_groups.id? | RULED (doc 35 §6d): `staff_groups.id`, never the name. A name is mutable display and a rename must not change a rule’s historical meaning; authoring resolves name → id at save. |
| `RK-RULING-03` | RULED | `ValidGroupRestriction` | What identifier domain does ValidGroupRestriction.validGroup name — a name or an id? | RULED (doc 35 §6d): `valid_groups.id`, never the name. As RK-RULING-02. |
| `RK-RULING-04` | RULED | `PickPositionRestriction` | Does a NULL pick_position — which every manual assignment carries — satisfy or breach a PickPositionRestriction? | RULED (doc 35 §6d): out of scope of the restriction — a NULL pick position satisfies VACUOUSLY. The restriction speaks about pick positions; an assignment that has none makes no statement about one. Breaching on NULL would make every manual override a breach and would manufacture a violation from an absence (the FAD-23 class). Both arms pinned. |
| `RK-RULING-05` | RULED | `WeekdayFteLimit` | Over what accounting period is a WeekdayFteLimit fraction a limit — a week, the period, a rolling window? | AUTHORED by OPUS-M4-002 for FAD ratification: per weekday over the ACCOUNTING WINDOW (the rule’s scope.dateRange intersected with the build horizon; the period when the scope names none), a membership’s scoped assignments on weekday w may not exceed min(⌈node.fteFraction × N(w)⌉, ⌈profile.fteFraction(w) × N(w)⌉, profile.maxAssignments(w)) over whichever terms are present, N(w) = the count of w-dates in the window; the profile is the one in force at the build instant (S-03). MIN rather than “the profile overrides”: SPEC-04 §3.3 forbids any path that RELAXES a HARD rule, so every present term binds and the tightest wins — the one departure from the packet’s proposed wording, in the only direction §3.3 permits. weekday=holiday is not-evaluable: no holiday calendar is a snapshot constituent. |
| `RK-RULING-06` | RULED | `WorkPercentageTarget` | Is a WorkPercentageTarget a bound at all? A target is not a bound, so "breach" is undefined until the owner says whether it is a floor, a ceiling, or a tolerance band. | AUTHORED by OPUS-M4-002 for FAD ratification: a TARGET, never a bound. It compiles to a SOFT objective term penalising \|achieved − target\|, expressed in ASSIGNMENT UNITS — penalty(m) = \|count(m) − round(targetPercentage/100 × B(m))\| where B(m) is the number of dates in the accounting window — which is proportional to \|achieved − target\| by a constant factor and keeps the objective integral, so no rounding choice becomes a silent semantic one. E1 carries the basic penalty; weights are E2 (M4-004). A HARD authoring is a classification contradiction with no defined breach and blocks fail-closed. |
| `RK-RULING-07` | RULED | `NoAdjacent` | Does NoAdjacent mean consecutive calendar days, or back to back in time (an end instant meeting a start instant)? | RULED (doc 35 §6d): CONSECUTIVE CALENDAR DATES (start-date attribution), symmetric over the pair. Instant-gap semantics belong to MinimumRestBetween alone — one concern, one spelling. |
| `RK-RULING-08` | RULED | `ForbiddenSequence` | Is a ForbiddenSequence a run of the membership’s CONSECUTIVE assignments (an intervening third shift type breaks it), or its assignments in order (an intervening type does not)? | RULED (doc 35 §6d): the named shift-type sequence matched over consecutive calendar dates, in order; an intervening different scoped assignment on a date between them BREAKS the run. Pinned with an intervening-type arm and a gap-day arm. |
| `RK-RULING-09` | RULED | `ImpliesAssignment`, `LinkedShifts`, `MutuallyExclusive` | What does linkage bind — the same membership, the same date, or both? And for MutuallyExclusive, exclusive over what window? | RULED (doc 35 §6d): binds the SAME MEMBERSHIP and the SAME CALENDAR DATE for LinkedShifts / ImpliesAssignment / MutuallyExclusive; MutuallyExclusive is exclusive over a single date. Wider windows are expressed through scope.dateRange, never invented per node. |
| `RK-RULING-10` | RULED | `FixedAssignment` | What is a FixedAssignment.assignmentIdentity key? The AST documents a KEY and assignment_identities carries only a uuid id. | RULED (doc 35 §6d) and CONFIRMED against snapshot v2 by OPUS-M4-002: the identifier domain is `assignment_identities.id` (uuid, opaque, UI-selected). The canonical input’s fixedAssignments[] already carries assignmentIdentityId, so NO schema change is needed — the `alsoNeeds` line below described the v1 world and the ruling superseded it. A human-meaningful cross-period key remains a recorded future owner question. |
| `RK-RULING-11` | RULED | `AvoidDate` | Does AvoidDate attribute an assignment to its START date (shipped, and what the daily sheet, the grid and D-1a already use), or to any working minute falling on the date? | RULED (doc 35 §6d): START-date attribution STANDS — consistent with the shipped evaluator, D-1a, the daily sheet and the grid. An overnight shift STARTING on the avoided date breaches; one starting the day before and spilling into it does not. An any-working-minute variant would be a NEW node kind (a schema change), never a reinterpretation. |

## The one-ruling-away population

0 kinds: .
