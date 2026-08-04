# OPUS-M3-002 — Mandatory pre-migration escalation: the `pattern_rules` / `staff_rules` relationship to the typed `rules` model

**Status: STOP — awaiting a Fable ruling before migration `0008` is written.**
This is the pre-migration escalation the packet (docs/fable/32 §4, "Required
implementation — AST + tables") makes mandatory: *"the relationship between the
typed `rules` table and doc 06's `pattern_rules`/`staff_rules` rows (whether they
are expressed as scopes/categories of the typed model or as separate tables) —
propose with rationale, Fable rules before the migration is written."* No schema
choice has been made silently. Migration `0008` and everything that depends on
the table shape (authoring API, persistence round trip, authoring UI, SBX-004
sweep of the new tables, audit) is **not written** and is held for this ruling.

## The question

Doc 06 §3.2 lists **four** relevant rows:

| Row | Fields (doc 06 §3.2) | Sensitivity |
|---|---|---|
| `pattern_rules` | `name`, `trigger`, `days_of_week`, `date_scope`, `segments` | `NONE` |
| `staff_rules` | `name`, `conditions`, `action`, `action_params`, `days_of_week` | **`INTERNAL`** (names individuals) |
| `rule_sets` | `name`, rule id arrays | `NONE` |
| `rules` **NEW (CAR-006)** | `rule_key`, `rule_schema_version`, `classification`, `weight?`, `scope`, `predicate` (typed AST) | `INTERNAL` |

`rules` and `rule_sets` are unambiguous — I create them in `0008`. The open
question is whether `pattern_rules` and `staff_rules` are **(a)** categories /
scopes of the one typed `rules` model, or **(b)** separate tables that coexist
with `rules`.

## Recommendation — **(a): categories of the typed model, not separate tables**

Migration `0008` should create **`rules` and `rule_sets` only.** The
`pattern_rules` and `staff_rules` concepts should be preserved as **rule
categories within the one typed model**, not as separate free-form tables. I
recommend an additive, Fable-authored doc-06 amendment recording this (the same
mechanism as FAD-16/17/18), because I may not edit doc 06.

### Rationale

1. **Separate free-form tables would be the escape hatch the whole design
   forbids.** `pattern_rules.segments` and `staff_rules.{conditions, action,
   action_params}` are free-form/JSON-shaped columns. If they remain as a second,
   *untyped, uncompiled, unvalidated* rule path alongside the typed `rules`
   table, they are exactly the "free-text/JSON escape hatch" SPEC-04 §3.1 and
   CLAUDE.md's hard rule ("a rule the AST cannot express is a schema change with
   a migration, never an escape hatch") prohibit. CAR-006 introduced `rules`
   *because* `Constraint[]` / free-form constraint objects were the CAR-006
   defect. Materialising two more free-form tables would re-open it.

2. **SPEC-04 §3.1 already places these concepts *inside* the typed AST.** The
   **Pattern** node family is `PatternRule(trigger, days_of_week, segments)`,
   `AlternatingWeek`, `TemplateAdherence` — `PatternRule`'s parameters are the
   `pattern_rules` fields verbatim (`trigger`, `days_of_week`, `segments`), now
   with `segments` a **typed** `PatternSegment[]` rather than a JSON blob.
   `staff_rules` — condition/action content that *names individuals* — is
   expressed as typed nodes (`FixedAssignment`, `AvoidDate`, `ShiftPreference`,
   `RequestHonoured`, `LocumRestriction`, the eligibility/linkage restrictions)
   whose `scope.memberships[]` carries the "names individuals" dimension. The AST
   is the intended single home; doc 06's two rows predate CAR-006's `rules`.

3. **No capability is dropped (non-bypass rule 11).** Every field of both rows is
   expressible in the delivered closed node set — demonstrated concretely in
   §"Field mapping" below. Nothing becomes inexpressible; it becomes *typed*.

4. **Sensitivity is preserved and, better, derived.** The `staff_rules`
   `INTERNAL` "names individuals — narrower access" requirement is honoured by
   `ruleSensitivity(rule)`, which returns `INTERNAL` whenever `scope.memberships`
   is non-empty — derived from the AST rather than asserted by the author. The
   `rules` row itself is stored `INTERNAL` as doc 06 already assigns.

5. **Stable IDs (non-bypass rule 13).** `rule_key` is the stable identifier; a
   `category` discriminator does not renumber anything. Keeping one table avoids
   a second key space that could collide or drift.

### Concrete shape I would implement once ruled (a)

- `rules` as doc 06 §3.2 defines it, **plus** an additive typed enum column
  `category ∈ {general, pattern, staff}` (default `general`) so the two observed
  rule classes remain first-class and queryable, and so `staff`-category access
  narrowing is enforceable at the row level in addition to the derived
  sensitivity. `category` is a closed enum (CHECK-constrained), never free text.
- `rule_sets` as doc 06 defines it.
- The `CHECK ((classification='HARD' AND weight IS NULL) OR (classification='SOFT'
  AND weight IS NOT NULL))` (CAR-006) as the database half of the hard/soft
  invariant.
- Group tenant, RLS ENABLE + FORCE + policy in the same migration, composite
  tenant FKs — exactly the gate-enforced pattern.

### Field mapping (evidence that (a) drops nothing)

| doc 06 row / field | Typed-model expression |
|---|---|
| `pattern_rules.trigger` | `PatternRule.trigger` |
| `pattern_rules.days_of_week` | `PatternRule.daysOfWeek` (RuleWeekday set, incl. holiday) |
| `pattern_rules.date_scope` | `RuleScope.dateRange` |
| `pattern_rules.segments` | `PatternRule.segments: PatternSegment[]` (**now typed**) |
| `staff_rules.conditions` | the predicate node kind + `scope` (staff group / valid group / qualification / membership) |
| `staff_rules.action` / `action_params` | the concrete node (`FixedAssignment`, `AvoidDate`, `ShiftPreference(strength)`, `RequestHonoured`, `LocumRestriction`, …) with typed params |
| `staff_rules.days_of_week` | `PatternRule.daysOfWeek` / `scope`, per the specific rule |
| `staff_rules` "names individuals → INTERNAL" | `scope.memberships[]` ⇒ `ruleSensitivity = INTERNAL`, plus `category = 'staff'` |

## Alternative considered — (b) separate tables

Rejected as the recommendation because it re-introduces the untyped rule path
CAR-006 exists to remove (point 1) and fragments compilation/validation across
three shapes. If Fable nonetheless rules **(b)** — e.g. to preserve an observed
authoring affordance — I will implement it exactly as ruled: I would need a
decision on whether the separate tables feed the compiler at all (they cannot
without their own typed schema) or are display-only, and the SBX-004 sweep /
audit obligations would extend to them.

## What is delivered regardless of the ruling (table-independent)

The AST, validation, compiler, canonical serialization, the new build-failing
unmapped-node gate, the contracts, and the B-* corpus are **complete and green**
and depend on none of the above. See `INDEX.md`. What waits on the ruling:
migration `0008`, the authoring API + persistence round trip, the authoring UI,
the SBX-004 sweep of the new tables, and audit through the `rules.*` namespace.
