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
| EVALUATED by the independent checker | 6 |
| NOT-EVALUABLE | 24 |
| Evaluated + not-evaluable | 30 (must equal the unique count; the two sets are disjoint) |
| One owner ruling away, nothing else needed | 11 |
| Awaiting input a named later milestone owns | 6 |
| Distinct pending rulings cited | 11 |

### By not-evaluable class

| Class | Kinds |
|---|---|
| `grouping-unit-not-pinned` | 3 |
| `semantics-not-pinned` | 8 |
| `identifier-domain-not-pinned` | 3 |
| `constrains-the-search-not-the-content` | 6 |
| `data-not-modelled-at-m3` | 4 |

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
| `RequiredCount` | coverage | hard | no | grouping-unit-not-pinned | assignment_snapshots; shifts; schedule_requirements | **RK-RULING-01** — What is the grouping unit a coverage count counts over — a shifts row within the version, a date, a date × shift type, or a date × shift type × location? | awaiting-ruling | M4-002 |
| `MinCoverage` | coverage | hard | no | grouping-unit-not-pinned | assignment_snapshots; shifts; schedule_requirements | **RK-RULING-01** — What is the grouping unit a coverage count counts over — a shifts row within the version, a date, a date × shift type, or a date × shift type × location? | awaiting-ruling | M4-002 |
| `MaxCoverage` | coverage | hard | no | grouping-unit-not-pinned | assignment_snapshots; shifts; schedule_requirements | **RK-RULING-01** — What is the grouping unit a coverage count counts over — a shifts row within the version, a date, a date × shift type, or a date × shift type × location? | awaiting-ruling | M4-002 |
| `RequiresQualification` | eligibility | hard | yes | — | qualification_holdings; qualifications.key; qualifications.status; assignment_snapshots.date | Every scoped active assignment’s assignee held the named qualification, valid at the assignment’s date. validAt is a fixed literal shift_date in the AST. | independent-checker | M3-008 |
| `MemberOfStaffGroup` | eligibility | hard | no | identifier-domain-not-pinned | staff_groups; staff_group_members | **RK-RULING-02** — What identifier domain does RuleScope/MemberOfStaffGroup.staffGroup name — staff_groups.name or staff_groups.id? | awaiting-ruling | M4-002 |
| `ValidGroupRestriction` | eligibility | hard | no | identifier-domain-not-pinned | valid_groups; valid_group_shift_types | **RK-RULING-03** — What identifier domain does ValidGroupRestriction.validGroup name — a name or an id? | awaiting-ruling | M4-002 |
| `PickPositionRestriction` | eligibility | hard | no | semantics-not-pinned | assignment_snapshots.pick_position | **RK-RULING-04** — Does a NULL pick_position — which every manual assignment carries — satisfy or breach a PickPositionRestriction? | awaiting-ruling | M4-002 |
| `MaxAssignmentsInWindow` | capacity | hard | yes | — | assignment_snapshots.date | Per membership, no ROLLING window of windowDays consecutive dates contains more than max scoped assignments. The node carries no anchor and no alignment field, so a calendar-aligned window would have to invent one. | independent-checker | M3-008 |
| `WeekdayFteLimit` | capacity | hard | no | semantics-not-pinned | membership_weekday_fte.fte_fraction; membership_work_profiles | **RK-RULING-05** — Over what accounting period is a WeekdayFteLimit fraction a limit — a week, the period, a rolling window? | awaiting-input | M4-001 |
| `WorkPercentageTarget` | capacity | soft | no | semantics-not-pinned | membership_work_profiles.work_percentage | **RK-RULING-06** — Is a WorkPercentageTarget a bound at all? A target is not a bound, so "breach" is undefined until the owner says whether it is a floor, a ceiling, or a tolerance band. | awaiting-input | M4-001 |
| `MaxConsecutive` | capacity | hard | yes | — | assignment_snapshots.date | Per membership, no run of more than maxDays CONSECUTIVE CALENDAR DATES carries a scoped assignment. Two assignments on one date are one day. | independent-checker | M3-008 |
| `MinimumRestBetween` | rest-and-spacing | hard | yes | — | assignment_snapshots.starts_at; assignment_snapshots.ends_at | Per membership, the gap from one assignment’s ends_at to the next’s starts_at is at least minHours. | independent-checker | M3-008 |
| `CallSpacing` | rest-and-spacing | hard | yes | — | assignment_snapshots.date; shift_types.is_on_call | Per membership, consecutive ON-CALL assignments are at least minDaysBetweenCalls calendar days apart; non-call shifts are ignored. shift_types.is_on_call (migration 0005) is the one attribute that says a shift is a call. | independent-checker | M3-008 |
| `NoAdjacent` | rest-and-spacing | hard | no | semantics-not-pinned | assignment_snapshots.date; shift_types.code | **RK-RULING-07** — Does NoAdjacent mean consecutive calendar days, or back to back in time (an end instant meeting a start instant)? | awaiting-ruling | M4-002 |
| `ForbiddenSequence` | rest-and-spacing | hard | no | semantics-not-pinned | assignment_snapshots.date; shift_types.code | **RK-RULING-08** — Is a ForbiddenSequence a run of the membership’s CONSECUTIVE assignments (an intervening third shift type breaks it), or its assignments in order (an intervening type does not)? | awaiting-ruling | M4-002 |
| `PatternRule` | pattern | either | no | constrains-the-search-not-the-content | shifts; shift_types.code; group_holidays | Constrains the SEARCH, not the content: a pattern prescribes what a build assigns. Checking it against finished content would either always pass or invent a meaning. | solver-and-validator | M4-002 |
| `AlternatingWeek` | pattern | either | no | constrains-the-search-not-the-content | shifts; shift_types.code | Constrains the SEARCH, not the content: as PatternRule. | solver-and-validator | M4-002 |
| `TemplateAdherence` | pattern | either | no | data-not-modelled-at-m3 | assignment_templates (does not exist — doc 06 §3.2) | data-not-modelled-at-m3: `assignment_templates` does not exist yet (doc 06 §3.2) | awaiting-input | templates-slice |
| `LinkedShifts` | linkage | hard | no | semantics-not-pinned | assignment_snapshots; shift_types.code | **RK-RULING-09** — What does linkage bind — the same membership, the same date, or both? And for MutuallyExclusive, exclusive over what window? | awaiting-ruling | M4-002 |
| `ImpliesAssignment` | linkage | hard | no | semantics-not-pinned | assignment_snapshots; shift_types.code | **RK-RULING-09** — What does linkage bind — the same membership, the same date, or both? And for MutuallyExclusive, exclusive over what window? | awaiting-ruling | M4-002 |
| `MutuallyExclusive` | linkage | hard | no | semantics-not-pinned | assignment_snapshots; shift_types.code | **RK-RULING-09** — What does linkage bind — the same membership, the same date, or both? And for MutuallyExclusive, exclusive over what window? | awaiting-ruling | M4-002 |
| `RequestHonoured` | preference | soft | no | data-not-modelled-at-m3 | the request lifecycle (SPEC-08) — M5, not modelled | data-not-modelled-at-m3: the request lifecycle is M5 (SPEC-08) | awaiting-input | M5-requests |
| `ShiftPreference` | preference | soft | no | constrains-the-search-not-the-content | assignment_snapshots; shift_types.code | Constrains the SEARCH, not the content: a preference is a ranking, not a bound. It compiles to an objective term in M4-002. | solver-and-validator | M4-002 |
| `AvoidDate` | preference | either | yes | — | assignment_snapshots.date | No scoped assignment STARTS on the named date. _(open: **RK-RULING-11**)_ | independent-checker | M3-008 |
| `FairnessBalance` | fairness | soft | no | constrains-the-search-not-the-content | assignment_snapshots; credits; membership_work_profiles | Constrains the SEARCH, not the content: a balance metric has no pinned threshold to breach. It becomes an objective tier in M4-004. | solver-and-validator | M4-002 |
| `CreditDistribution` | fairness | soft | no | constrains-the-search-not-the-content | credits | Constrains the SEARCH, not the content: as FairnessBalance. | solver-and-validator | M4-002 |
| `StaffOverLocumPriority` | locum | soft | no | data-not-modelled-at-m3 | a membership attribute distinguishing a locum — none exists (doc 06 §3.2) | data-not-modelled-at-m3: no membership attribute distinguishes a locum (doc 06 §3.2) | awaiting-input | locum-slice |
| `LocumRestriction` | locum | hard | no | data-not-modelled-at-m3 | a membership attribute distinguishing a locum — none exists (doc 06 §3.2) | data-not-modelled-at-m3: as StaffOverLocumPriority | awaiting-input | locum-slice |
| `FixedAssignment` | fixed | hard | no | identifier-domain-not-pinned | assignment_identities (no key column); assignment_snapshots.is_pinned | **RK-RULING-10** — What is a FixedAssignment.assignmentIdentity key? The AST documents a KEY and assignment_identities carries only a uuid id. | awaiting-ruling | M4-002 |
| `ProtectedRange` | fixed | hard | no | constrains-the-search-not-the-content | assignment_snapshots.date | Constrains the SEARCH, not the content: a protected range bounds what a build may CHANGE, which finished content cannot violate. | solver-and-validator | M4-002 |

## Pending rulings

| Id | Ruling alone unblocks | Kinds | Question | Also needs |
|---|---|---|---|---|
| `RK-RULING-01` | yes | `MaxCoverage`, `MinCoverage`, `RequiredCount` | What is the grouping unit a coverage count counts over — a shifts row within the version, a date, a date × shift type, or a date × shift type × location? | — |
| `RK-RULING-02` | yes | `MemberOfStaffGroup` | What identifier domain does RuleScope/MemberOfStaffGroup.staffGroup name — staff_groups.name or staff_groups.id? | — |
| `RK-RULING-03` | yes | `ValidGroupRestriction` | What identifier domain does ValidGroupRestriction.validGroup name — a name or an id? | — |
| `RK-RULING-04` | yes | `PickPositionRestriction` | Does a NULL pick_position — which every manual assignment carries — satisfy or breach a PickPositionRestriction? | — |
| `RK-RULING-05` | no | `WeekdayFteLimit` | Over what accounting period is a WeekdayFteLimit fraction a limit — a week, the period, a rolling window? | the in-force work profile and weekday FTE for each membership at the shift date, which reaches the evaluator as canonical solver input in M4-001 |
| `RK-RULING-06` | no | `WorkPercentageTarget` | Is a WorkPercentageTarget a bound at all? A target is not a bound, so "breach" is undefined until the owner says whether it is a floor, a ceiling, or a tolerance band. | the same in-force work-profile input as RK-RULING-05 |
| `RK-RULING-07` | yes | `NoAdjacent` | Does NoAdjacent mean consecutive calendar days, or back to back in time (an end instant meeting a start instant)? | — |
| `RK-RULING-08` | yes | `ForbiddenSequence` | Is a ForbiddenSequence a run of the membership’s CONSECUTIVE assignments (an intervening third shift type breaks it), or its assignments in order (an intervening type does not)? | — |
| `RK-RULING-09` | yes | `ImpliesAssignment`, `LinkedShifts`, `MutuallyExclusive` | What does linkage bind — the same membership, the same date, or both? And for MutuallyExclusive, exclusive over what window? | — |
| `RK-RULING-10` | no | `FixedAssignment` | What is a FixedAssignment.assignmentIdentity key? The AST documents a KEY and assignment_identities carries only a uuid id. | a stable key column on assignment_identities, which is a schema change |
| `RK-RULING-11` | yes | `AvoidDate` | Does AvoidDate attribute an assignment to its START date (shipped, and what the daily sheet, the grid and D-1a already use), or to any working minute falling on the date? | — |

## The one-ruling-away population

11 kinds: `RequiredCount`, `MinCoverage`, `MaxCoverage`, `MemberOfStaffGroup`, `ValidGroupRestriction`, `PickPositionRestriction`, `NoAdjacent`, `ForbiddenSequence`, `LinkedShifts`, `ImpliesAssignment`, `MutuallyExclusive`.
