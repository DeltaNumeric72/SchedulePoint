# Step 06 — which HARD-rule node kinds are EVALUATED, and why the rest are not

**OPUS-M3-008 · SPEC-05 §6 step 06 · SPEC-04 §3.1/§3.3**

The packet is explicit: *"If evaluating a node kind requires semantics SPEC-04
leaves ambiguous, evaluate the kinds whose semantics are pinned and report
EVALUATED vs NOT-EVALUABLE per kind honestly — never guess semantics."* This
document is that report. It is the escalation list.

Implementation: `packages/domain/src/rules/hard-rule-check.ts` (the pure checker,
`EVALUATED_HARD_RULE_KINDS` and `NOT_EVALUABLE_REASONS`) and
`apps/api/src/schedule/hard-rule-revalidation.ts` (the loading half).

---

## 1. The disposition of an unevaluable HARD rule — the ruling this needs

**An active HARD rule this checker cannot decide BLOCKS publication**, with a
`HARD_RULE_NOT_EVALUABLE` finding naming the rule key, the node kind, and the
reason.

The alternative — passing it over — is what SPEC-04 §3.3's first sentence
forbids: *"A `HARD` rule can never be relaxed, downgraded, weighted, or **skipped
by any code path**."* SPEC-05 §6's step 06 is `assert every HARD rule
re-validated`, and a rule that was not evaluated was not re-validated. A system
that answered "published" while silently ignoring a HARD rule an author wrote
would be making exactly the claim §3.3 exists to prevent, and the author would
have no way to find out.

**This is a deliberate, blocking choice with a real consequence, and it is put
forward for ruling rather than assumed.** Its practical blast radius is smaller
than it looks: the CAR-006 CHECK requires a weight on `SOFT` and forbids one on
`HARD`, so the kinds that are naturally weighted preferences (`FairnessBalance`,
`ShiftPreference`, `CreditDistribution`, `RequestHonoured`) are `SOFT` in any
sane authoring and are therefore outside step 06's population entirely. A HARD
`FairnessBalance` is pathological, and refusing to publish against one is the
honest answer.

It cost one fixture change, disclosed: `apps/api/test/support/rules.ts`'s
`coverageRule` was a HARD `RequiredCount` seeded into every swept group, which
correctly blocked SBX-018's publication. It is now a HARD `AvoidDate` on
2099-12-31 — still HARD, still `active`, still one row per group, and now
evaluable and satisfied. Making it `SOFT` or `disabled` would have removed it
from step 06's population and hidden the interaction instead of resolving it.

---

## 2. EVALUATED — 6 of the 30 kinds

Each is here because SPEC-04 §3.1, or the AST's own field documentation (the same
authority under FAD-21), pins its meaning without a choice being made in the
implementation.

| Kind | Semantics as evaluated | What pins it |
|---|---|---|
| `RequiresQualification` | Every scoped active assignment's assignee held the named qualification, **valid at the assignment's date** | `validAt` is a fixed literal `'shift_date'` in the AST; SPEC-04 §3.1 writes the node as `RequiresQualification(qualification, valid_at=shift_date)`; `qualification` is documented as `qualifications.key` |
| `MinimumRestBetween` | Per membership, the gap from one assignment's `ends_at` to the next's `starts_at` is ≥ `minHours` | The node carries hours and nothing else; there is no second reading of "minimum rest between" over a chronological list |
| `MaxConsecutive` | Per membership, no run of more than `maxDays` **consecutive calendar dates** carries a scoped assignment | The field is `maxDays`; a run is over days, and two assignments on one day are one day |
| `MaxAssignmentsInWindow` | Per membership, no **rolling** window of `windowDays` consecutive dates contains more than `max` scoped assignments | The node carries **no anchor and no alignment field**, so a calendar-aligned window would have to invent one. Rolling is the only anchorless reading |
| `CallSpacing` | Per membership, consecutive **on-call** assignments are at least `minDaysBetweenCalls` calendar days apart; non-call shifts are ignored | SPEC-04 §3.1 files it under "Rest and call spacing"; the field is `minDaysBetweenCalls` (so the unit is days); and **`shift_types.is_on_call`** is the one attribute in the system that says a shift is a call — migration 0005, M2 |
| `AvoidDate` | No scoped assignment **starts** on the named date | An ISO date and a HARD classification; "avoid" as a constraint is "must not". **The start-date attribution is a stated choice — see §2a** |

### 2a. `AvoidDate` attributes an assignment to its START date — stated, not assumed

"On that date" means `assignment_snapshots.date`, the shift's **start** date and
the single canonical date this schema anchors an assignment to. A 22:00→06:00
shift starting the day BEFORE an avoided date and running into it therefore does
**not** breach — it is attributed to its start date, as it is on the daily sheet,
in the grid, and in D-1a.

That is defensible and it is not the only reading. "Nobody works on the 25th"
could equally mean "no working minute falls on the 25th", which the overnight
shift does violate. The two disagree on exactly the rosters where the answer
matters, and SPEC-04 §3.1 chooses neither.

**So the shipped semantics is start-date equality, it is pinned by a test**
(`an overnight shift running INTO the avoided date does not breach`, with the
start-on-the-day control beside it), **and the attribution question is carried to
the owner in §5 rather than being changed silently.** Changing it later is a
ruling, not a bug fix. It is called out here because it is the same class of
attribution choice that made three other kinds NOT-EVALUABLE — the difference is
that this one has a canonical answer the rest of the system already uses.

### Scope resolution, and why an unresolvable scope is also a block

A rule's scope is evaluated before its predicate, and a scope this system cannot
resolve makes the rule NOT-EVALUABLE rather than empty:

| Scope dimension | Disposition |
|---|---|
| `dateRange` | **Resolvable** — ISO dates, no vocabulary needed |
| `shiftTypes` | **Resolvable against `shift_types.code`.** An entry that names no code in the group is NOT-EVALUABLE. (The AST documents `ForbiddenSequence.sequence` as "shift-type **codes**", which pins the domain) |
| `memberships` | **Resolvable against `memberships.id`.** An unresolvable entry is NOT-EVALUABLE |
| `staffGroups` | **NOT-EVALUABLE** — SPEC-04 §3.1 pins no identifier domain for it |

The dangerous alternative is an empty scope, which passes **vacuously** and
reports nothing: a HARD rule skipped by an unresolved identifier. That case has
its own test (`scope resolution is fail-closed` in
`packages/domain/test/rules/hard-rule-check.test.ts`).

---

## 3. NOT-EVALUABLE — 24 of the 30 kinds, each with its reason

Four reason classes. The distinction matters: two of them are **questions for the
owner**, and two are **M4's or a later milestone's work**.

### 3a. `grouping-unit-not-pinned` — a question for the owner (3 kinds)

The predicate is a count and SPEC-04 §3.1 does not say what it counts over: a
shift row? a date? a date × shift type? a date × shift type × location? Every
answer is a different business rule, and picking one here would be making a
product decision in a checker.

| Kind | Reason |
|---|---|
| `RequiredCount` | the count's grouping unit is not stated |
| `MinCoverage` | as `RequiredCount` |
| `MaxCoverage` | as `RequiredCount` |

**These three are the most likely to be authored as HARD in real use**, and are
therefore the most valuable to rule on. A ruling that fixes the grouping unit
(the recommendation is *per `shifts` row within the version*, which is the only
unit the schema already materialises) would move all three into §2.

### 3b. `semantics-not-pinned` — a question for the owner (7 kinds)

| Kind | What is ambiguous |
|---|---|
| `PickPositionRestriction` | whether a NULL `pick_position` — which **every** manual assignment has — satisfies or breaches the restriction |
| `WeekdayFteLimit` | the accounting period the fraction is a limit OVER (a week? the period? a rolling window?) |
| `WorkPercentageTarget` | as `WeekdayFteLimit`; and a *target* is not a bound, so "breach" is undefined |
| `NoAdjacent` | whether "adjacent" means consecutive calendar days or back-to-back in time |
| `ForbiddenSequence` | the sequence is a per-membership run of shift types, but nothing states whether it must be the membership's **consecutive assignments** (so an intervening third shift type breaks the run) or merely its assignments **in order** (so an intervening type does not). The two readings disagree on real rosters. *(The earlier wording called "back to back" unpinned while the `NoAdjacent` row beside it used "back-to-back in time" as its own disambiguation — and it named the wrong gap: the step is not the question, the binding is.)* |
| `LinkedShifts` | whether linkage binds the same membership, the same date, or both |
| `ImpliesAssignment` / `MutuallyExclusive` | as `LinkedShifts` — and for `MutuallyExclusive`, exclusive over what window? |

### 3c. `constrains-the-search-not-the-content` — genuinely M4 (7 kinds)

These describe what a BUILD may do, not a property finished content can violate.
Checking them against a completed version would either always pass or invent a
meaning.

`PatternRule` · `AlternatingWeek` · `ShiftPreference` · `FairnessBalance` ·
`CreditDistribution` · `ProtectedRange` · (and `StaffOverLocumPriority`, which is
also 3d)

### 3d. `data-not-modelled-at-m3` — a later milestone (4 kinds)

> **`CallSpacing` was in this table and should never have been.** Its recorded
> reason — "no shift-type attribute distinguishes a call" — was **factually
> false**: `shift_types.is_on_call` shipped in migration 0005 at M2, is typed as
> `isOnCall` in the domain and the contracts, and the revalidation loader already
> joined `shift_types`. The gap was one unselected column. The falsehood had
> propagated into this document, asking the owner to rule on building something
> that existed. It is EVALUATED in §2 and this row is gone. Found by the
> independent review (B-2); recorded here because a wrong reason in a
> ruling document is worse than a missing one.

| Kind | Missing input | Owning milestone |
|---|---|---|
| `TemplateAdherence` | `assignment_templates` does not exist (doc 06 §3.2) | the templates slice |
| `RequestHonoured` | the request lifecycle is M5 (SPEC-08) | M5 |
| `StaffOverLocumPriority` | no membership attribute distinguishes a locum | the locum slice |
| `LocumRestriction` | as `StaffOverLocumPriority` | the locum slice |

### 3e. `identifier-domain-not-pinned` (3 kinds)

| Kind | The unresolvable identifier |
|---|---|
| `MemberOfStaffGroup` | `staffGroup` is neither a declared name nor a declared id. `staff_groups`/`staff_group_members` **exist**, so this becomes evaluable the moment the domain is pinned — the cheapest of the twenty-four to close |
| `ValidGroupRestriction` | `validGroup`, as above |
| `FixedAssignment` | `assignmentIdentity` is documented as a **key**, and `assignment_identities` carries no key column — only a uuid `id` |

---

## 4. Totality is asserted, not asserted-in-prose

`packages/domain/test/rules/hard-rule-check.test.ts`:

- every one of the 30 `RULE_NODE_KINDS` is either in `EVALUATED_HARD_RULE_KINDS`
  or has an entry in `NOT_EVALUABLE_REASONS` — a kind added to the AST without a
  decision here fails the test rather than falling through to a generic message;
- the two sets are disjoint;
- `6 + 24 = 30`, asserted as two numbers so neither can drift alone.

So this document cannot silently go stale against the code.

---

## 5. What a ruling would change

| If the owner rules… | Kinds that move to EVALUATED | Work |
|---|---|---|
| the coverage grouping unit (§3a) | 3 | small — the join already exists |
| `staffGroup` / `validGroup` identifier domain (§3e) | 2 | small — `staff_group_members` is already there |
| `NoAdjacent`'s "adjacent" = consecutive calendar days (§3b) | 1 | small |
| `ForbiddenSequence`'s binding — consecutive assignments, or assignments in order? (§3b) | 1 | small |
| `LinkedShifts` binding (§3b) | 3 | small |
| a NULL pick position's disposition (§3b) | 1 | trivial |
| **`AvoidDate` attribution** — start date (shipped) or any working minute? (§2a) | 0 (it is already evaluated) | small, but it **changes shipped behaviour**, so it is a ruling and not a fix |

Ten of the twenty-four are one ruling away each, and one **already-evaluated**
kind (`AvoidDate`) has an open attribution question whose answer would change
what it does. The remaining fourteen are
genuinely M4's or a later milestone's and are recorded against their owners in
§3c and §3d — **none is dropped, deferred without an owner, or narrowed**
(non-bypass rule 11).

**One entry in this document was wrong rather than merely incomplete**, and that
is worth more attention than the arithmetic: `CallSpacing`'s reason asserted that
a piece of the schema did not exist when it had shipped a milestone earlier. A
ruling document whose reasons are not checked is a way to get a decision made
about the wrong thing. Every reason above was re-read against the schema after
that finding.
