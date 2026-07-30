# 05 — Scheduling Configuration, Rules & Builds: ischedule.MD

**Phase:** 6 — scheduling-administration and engine-configuration audit.

**Method:** Read-only per [RESEARCH-RULES.md](../RESEARCH-RULES.md). Every authoring form (Pattern Rule Setup, Staff Rule Setup, Build Setup/Setup, "Pick Shifts," Valid Group Setup) was opened to inspect field structure and, where already-populated, existing values — none was saved, none was deleted, no Build stage (Setup/Planner/Build/Fix Picks/Publish/Lock) was invoked. Merges by stable ID into [01-application-map.md](01-application-map.md) (ADM-01 through ADM-10) and [02-role-permission-matrix.md](02-role-permission-matrix.md) (ADM-11); adds no new top-level screen IDs (all screens here were already inventoried) but substantially deepens the field-level record for each.

**Evidence labels:** **[OBSERVED]** · **[INFERRED]** · **[UNRESOLVED]**.

**Exclusions honored:** no real staff names, emails, or phone numbers reproduced (Staff Rules examples use anonymized placeholders consistent with prior reports).

---

## 1. Configuration screens — field-level detail

### ADM-01 — Group Settings (`/admin/groups`)

Already fully catalogued in Phase 1 §"ADM-01." No new fields found this phase. Recap of the fields most relevant to the engine (for cross-reference): Request Until Date, Schedule End Date, Pick List Start/End Time, Personal Start/End Time, Locum Lockout Hours, Lockout Minimum Hours, Vacation shift, Final Picklist Emails, Alert Pick Time/Alert Average Pick Time, ImportStrip, OR Daily Defaults (per-weekday-including-holidays), and a group-level default notification-escalation ladder. **Save/deletion behaviour:** a single **Save** button for the whole form; no per-field save. Not exercised.

### ADM-02 — Builds (`/admin/builds`) & Build Setup (new detail this phase)

**Purpose:** version-controlled generation pipeline for the Master Schedule.

**Build list fields [OBSERVED, recap]:** Delete, Name, Dates, Days, and per-row pipeline buttons **Setup → Planner → Build → Fix Picks → Publish → Lock/Unlock**; top-level **New Build** and **Erase Master Schedule**.

**Build Setup / "Build Editor" screen (opened this phase, URL `/admin/schedulebuildsmanagement?buildId=<N>`) — full field inventory [OBSERVED]:**

| Field | Type | Notes |
|---|---|---|
| Name of Build | text | free text, e.g. "Q2 Step3 (Jul to Dec 2026)" |
| Build Start Date | date, **must be a Monday** | validated by helper text |
| Build End Date | date, **must be a Sunday** | validated by helper text |
| Use Previous Schedule Statistics | Yes/No toggle | continuity of fairness stats across build periods |
| Previous Statistics Start Date / End Date | dates | only meaningful when the above is Yes; explicit validation note: *"Previous Statistics End Date must be at least one day before the Build Start Date. Do NOT overlap dates."* |
| Days of previous schedule | number | e.g. 14 |
| **Progressive Build** | multi-select chip list of *other builds* | lets a build reference and build upon 1+ prior build steps — this is the mechanism behind the "Step 1/2/3/4" naming convention seen throughout the Builds list: each step is a distinct build object that chains to its predecessor(s), rather than the naming being purely cosmetic |
| Show Only Staff in Build? | Yes/No toggle | |
| Solve In Order of MIN Staff? | Yes/No toggle | solver-ordering hint |
| Copy OR Template to Planner | button ("Copy") + help icon | copies an Operating-Room template into the Planner stage |
| **Staff (N)** | roster, chip list | + Add Staff / Add Locum / Add All / Clear |
| **Shifts (N)** | multi-select chip list | which shift codes from the master catalog (ADM-07) are in scope for this build — includes codes beyond the ~30 seen elsewhere (e.g. `OB C/S`, `OFF G`, `OFF L`, `ORTBA`, `TEEoutpt`, `Sat-Ortho`, `Sat-Other`, `TOP1/3`, `MC/TC`, `OFF W`), confirming the full shift catalog is larger than any single grid legend shows at once |
| **Shift Groups (N)** | multi-select chip list | e.g. one group combining two call-related shift codes |
| **Pattern Rules (N)** | multi-select chip list | opts specific Pattern Rules (ADM-10) into this build; observed instance had all 11 rules opted in |
| **Staff Rules (N)** | multi-select chip list | opts specific Staff Rules (ADM-11) into this build; observed instance had all 6 opted in |
| **Valid Groups (N)** | multi-select chip list | opts specific Valid Groups (§ below) into this build; observed instance had both opted in |
| — | warning note | *"⚠ Generate Planner if you make changes to staff or shifts"* — ties Setup-stage edits to needing the Planner stage re-run |
| — | actions | **Delete Build** / **Cancel** / **Save** / **Save & Generate Planner** |

**Given/When/Then:**
> **Given** an admin opens Setup for an existing, unlocked build
> **When** they change the Staff or Shifts chip lists
> **Then** the form displays a warning that the Planner must be regenerated for the change to take effect — implying the Planner stage caches/derives from Setup's chip-list state rather than reading it live at Build-run time

**Not exercised:** no chip was added/removed, and neither Save button was clicked; the form was closed via **Cancel**.

### ADM-03 — Staff Shift FTE (`/admin/staffshiftfte`)

No new fields this phase; recap: per-shift-type (selector + Prev/Next Shift) table of Staff Name / Edit / Active (Yes/No) / Max Shifts / per-weekday quota columns (All, Mon…Sun, Hol).

### ADM-04 — Shift Statistics (`/admin/shiftstatistics`)

No new fields this phase; recap: date range, shift-type selector, Shifts-vs-Percentage toggle with a numeric credit weight, Show Variance, Credits/(Target)/Actual Shifts legend.

### ADM-05 — Staff/Users (`/admin/users`)

Fully documented in Phase 3. No new fields this phase.

### ADM-06 — Staff Groups (`/admin/staffgroup`)

No new fields this phase; recap: Id, Name, Staffs (member chip list), New/Edit/Delete.

### ADM-07 — Shifts (`/admin/shifts`) + "Pick Shifts" (new this phase)

**Shifts catalog table [OBSERVED, recap]:** Full Name, Short Name, Time Start/End, Call (Yes/No), Manually (Yes/No), DailyPick (Yes/No), Stipend (Yes/No), per-row Picks "Edit," Delete, New.

**"Picks" header button → "Pick Shifts" modal (new finding):**

- **Field:** "Number of pick positions:" — a single number stepper, observed value **30**.
- **Validation/constraint note [OBSERVED]:** *"⚠ Warning: You may only increase the number of pick shifts for your group. These may not be deleted in the future."*
- **Actions:** Cancel / **CREATE PICK SHIFTS** (not clicked).
- **Data model implication:** this is the source of every "1st…30th" pick-order label seen throughout the product (Master Schedule, My Schedule, Picklist Manager, Valid Groups). The count of numbered draft positions is a **group-wide, monotonically-increasing-only** setting — once a position number exists it can never be removed, only new higher numbers added. This is a hard architectural constraint worth deliberately deciding on (keep vs. relax) in a clean-room redesign.

### ADM-08 — Shift Groups (`/admin/shiftgroup`)

No new fields this phase; recap: Id, Name, Shifts (member codes), Equation & Weight (Hard(0) / Linear(1000) observed), Allow Request (Yes/No), Request Off Text.

### ADM-09 — Valid Groups (`/admin/validgroups`) — fully resolved this phase

Phase 1 left this screen's purpose as **[INFERRED]**/unresolved. Opening **Edit** on one entry resolved it:

- **Fields [OBSERVED]:** Name of Valid Group, **Group One** (a chip list of specific shift codes, e.g. two call-related codes), **Group Two** (a chip list of pick-order positions — observed instance had **all 30** positions, 1st through 30th, selected), Delete / Cancel / Save.
- **Resolved purpose:** a Valid Group defines which **pick-order positions** (Group Two) are legal/valid for a given set of **shift codes** (Group One). In the observed instance, Group Two included every available position (1st–30th), meaning that particular pairing is effectively unrestricted — but the mechanism clearly supports narrowing Group Two to a subset, which would restrict certain shift types to only be pickable from specific draft positions (e.g., reserving early positions for certain call types, or preventing a shift from ever being picked in a very late position). **[OBSERVED field structure; INFERRED general-case behavior beyond the one unrestricted example seen]**
- Not saved; closed via Cancel.

### ADM-10 — Pattern Rules (`/admin/patterns`) + "Pattern Rule Setup" (new detail this phase)

**List fields [OBSERVED, recap]:** ID, Pattern Name, Pattern (DSL string), Days, Delete/Edit, Add New.

**"ADD NEW" → "Pattern Rule Setup" form — full field inventory [OBSERVED]:**

| Field | Type | Notes |
|---|---|---|
| Name of Pattern | text | |
| When engine is assigning | autocomplete: "Type Shift or {Shift Group}" | the trigger/activation condition |
| On these days | checkboxes: Mon/Tue/Wed/Thu/Fri/Sat/Sun/Holiday | + an "All days" quick-select |
| During these dates | radio: All Schedule Dates / Date Range | |
| **Pattern Builder** table | MATCH / OFFSET / PENALTY columns, built row-by-row | |
| — match input | autocomplete: "Type Shift or {Shift Group}" | the shift/group being matched against the trigger |
| — offset mode | radio: **"Day Offset from consideration shift"** (+ a numeric Offset field) vs. **"Optimal Spacing"** (no manual number — an engine-computed strategy) | resolves the "(Optimal Spacing)" vs. "(-7)/(7)/(-1)" distinction seen in the Pattern list: explicit offsets are manually chosen numbers; "(Optimal Spacing)" is a named auto-computed strategy |
| — penalty mode | radio: **"Weight Penalty"** (+ numeric Weight) vs. **"Hard Penalty"** (no weight) | resolves the "Hard(0)" vs. "Linear(1000)" terminology seen on Shift Groups: **Hard = a non-negotiable constraint**, **Weight = a soft, numerically-scored preference** |
| ADD TO PATTERN | button | appends the current match row to the pattern being built — explains the `/`-chained multi-segment patterns seen in the list (each `/`-separated segment is one row added this way) |
| Cancel / Save | | not exercised |

**Given/When/Then:**
> **Given** an admin is authoring a Pattern Rule
> **When** they choose "Hard Penalty" instead of "Weight Penalty" for a match row
> **Then** that row becomes a non-negotiable constraint rather than a scored preference — directly explaining why some Shift Groups are tagged "Hard (0)" (a weight of zero is meaningless for a true hard constraint; it is a display convention for "this is hard, not weighted") while others carry a real numeric weight like "Linear (1000)"

### ADM-11 — Staff Rules (`/admin/staffrules`) + "Staff Rule Setup" (new detail this phase — substantially richer than the 6 existing examples suggested)

**List fields [OBSERVED, recap from Phase 3]:** ID, Staff Rule Name, Rule (DSL), Days, Delete/Edit, Add New.

**"ADD NEW" → "Staff Rule Setup" form — full field inventory [OBSERVED]:**

Shares Name/When-engine-is-assigning/On-these-days/During-these-dates with Pattern Rule Setup, but the builder is richer:

- **IF clause:** "Type Shift or {Shift Group}" + numeric OffSet + **"Staff or {Staff Group}"** selector + a **"Not"** toggle (negation — "IF this staff/group is *not* assigned to X" is a supported condition, not just positive matches) + an **"AND Staff Balance [operator ▾] [value]"** compound condition (a checkbox to additionally require the day's Staff Balance metric to satisfy a comparison — linking this rule type directly to the Master Schedule's Staff Balance figure documented in 04-master-schedule.md).
- **THEN clause — five mutually-exclusive action types (radio-select):**
  1. **Assign** — directly assign a specific Staff
  2. **Penalty** — apply a weighted penalty (Staff or {Staff Group} + Weight)
  3. **Exclude** — exclude a Staff or {Staff Group} from consideration entirely
  4. **Linked** — reference another "Shift to Assign" with its own Offset (chains this rule's effect to a second shift)
  5. **Staff-Shift** — directly bind a specific Staff to a specific "Shift to Assign," with an Offset
- **ADD TO RULE** button appends the current IF/THEN pair; Cancel/Save not exercised.

**Significance:** the six pre-existing Staff Rules in this tenant all happen to use only the simple `WHEN ASSIGN / IF … Assigned / THEN Penalty` shape — but the authoring form reveals the engine supports a **materially richer rule language** (direct assignment, exclusion, staff-group targeting, negation, Staff-Balance-conditioned rules, and shift-linking) that this tenant simply hasn't exercised yet. Any clean-room reimplementation should treat the *simple* examples as a floor, not the ceiling, of what the constraint engine is designed to express.

---

## 2. Optimization settings, schedule-generation controls, build history/status/errors

- **Optimization settings:** distributed across Build Setup (Solve In Order of MIN Staff?, Use Previous Schedule Statistics), Pattern/Staff Rules (Hard vs. Weight penalties, Optimal Spacing), and Shift Groups (Equation & Weight) — there is **no single centralized "optimizer settings" screen**; tuning is composed from these several surfaces. **[OBSERVED]**
- **Build history:** the Builds list itself, retaining every historical build row (sequential IDs, e.g. `B783/B781/B778/B771` for one period) rather than overwriting — a build is never silently replaced, only superseded by a newer one in the same "Step" chain. **[OBSERVED]**
- **Build status:** only two states directly labeled — **Locked** (shows only "Unlock") and its implicit opposite, unlocked/in-pipeline (shows the full Setup→Planner→Build→Fix Picks→Publish→Lock button row). No distinct "Draft," "Running," "Failed," or "Complete" status label was found anywhere on this screen. **[OBSERVED the two states that exist; UNRESOLVED whether intermediate/failure states exist and are simply not visible without triggering a real build]**
- **Build errors:** **[UNRESOLVED]** — no error state was encountered, since no build stage was ever run.

---

## 3. Rule/effect determination — observed vs. inferred

| Concept | Determination | Confidence |
|---|---|---|
| **Required build inputs** | Name, Start (Mon)/End (Sun) dates, Staff roster, Shifts, Shift Groups, Pattern Rules, Staff Rules, Valid Groups; Progressive Build chain optional; previous-statistics continuity optional | **[OBSERVED]** — full Setup form inspected |
| **Schedule periods** | A build's date range is fixed at Setup and independently versioned per "Step"; periods observed spanned ~166–182 days (roughly semester/quarter blocks) | **[OBSERVED]** |
| **Shift demand** | Driven by which Shift codes/Shift Groups are opted into the build, further scoped per-weekday by Staff Shift FTE and Group Settings' OR Daily Defaults | **[OBSERVED, composed from multiple screens]** |
| **Staff targets** | Per-shift Max Shifts and per-weekday quota columns (Staff Shift FTE); per-staff vacation Grant separately in the Vacation module | **[OBSERVED]** |
| **Hard rules** | Pattern/Staff Rule penalty mode = "Hard Penalty" (no weight — a non-negotiable constraint) | **[OBSERVED]** |
| **Soft rules** | Pattern/Staff Rule penalty mode = "Weight Penalty" (numeric weight); Shift Group "Linear(N)" weighting | **[OBSERVED]** |
| **Weights/equations** | Two named equation types confirmed: "Hard" and "Linear" (Shift Groups); Pattern/Staff Rules additionally support "Optimal Spacing" as a distinct offset *strategy* (not a weight) | **[OBSERVED]** |
| **Pattern rules effect** | Spacing/activation constraints scoped by weekday, evaluated presumably during Build/Fix Picks stages | **[INFERRED]** — not observed firing during an actual build run |
| **Staff-specific rules effect** | Named-individual/pair penalty overrides layered atop the general pattern/weight system, additionally capable of hard assignment, exclusion, and Staff-Balance-conditioned logic | **[OBSERVED structure; INFERRED runtime effect]** |
| **Valid groups effect** | Restrict which pick-order positions are legal for a given shift set | **[OBSERVED for the unrestricted example; INFERRED general restrictive case]** |
| **Vacation and request effects on builds** | **[UNRESOLVED]** — no explicit "exclude vacationed staff" toggle was found on Build Setup; presumably the engine consults the Vacation module and Group Settings' "Vacation shift" code automatically, but this was not directly confirmed |
| **Manual-assignment effects** | The Master Schedule cell editor's direct Move Shift/Move Credit/Add path exists as a secondary mechanism alongside the picklist-driven path, with its own audit trail (04-master-schedule.md §3) | **[OBSERVED]** |
| **Build initiation** | "Start List" (Picklist Manager) begins a *daily picklist* draft; "Build" (Builds pipeline) generates the underlying *schedule* a picklist draws from — these are two distinct initiation actions at two different layers (schedule generation vs. daily draft) | **[OBSERVED labels; INFERRED relationship]** |
| **Generated output** | A published Master Schedule (viewable in all three views) plus picklists per day | **[INFERRED]** |
| **Failure handling / regeneration / review** | **[UNRESOLVED]** — the "Progressive Build" chip list and the "Q2 Step 1/2/3/4" naming convention strongly suggest an iterative regenerate-and-review workflow (each Step likely represents a re-run after reviewing the prior Step's output), but no failure state or review-diff screen was found | **[INFERRED, moderate confidence]** |
| **Publication** | The green "Publish" button (with a distinct cloud/people icon) on each unlocked build row | **[OBSERVED existence; INFERRED effect — makes the build's output live on Master Schedule]** |

---

## Master checklist — Phase 6 topics

| Topic | Status |
|---|---|
| Group settings | **[OBSERVED]** (recap, no new fields) |
| Builds / build management | **[OBSERVED]** in depth — full Setup form, Progressive Build chain, Pick Shifts constraint |
| Schedule planner | **[UNRESOLVED]** — Planner button did not visibly open a distinct screen in this session (plausibly requires "Save & Generate Planner" to have been run first); not forced |
| Staff Shift FTE | **[OBSERVED]** (recap) |
| Statistics | **[OBSERVED]** (recap) |
| Staff administration | **[OBSERVED]** (Phase 3) |
| Staff groups | **[OBSERVED]** (recap) |
| Shift definitions | **[OBSERVED]** + new "Pick Shifts" / number-of-positions constraint |
| Shift groups | **[OBSERVED]** (recap) |
| Valid groups | **[OBSERVED]** — fully resolved this phase (was open in Phase 1) |
| Pattern rules | **[OBSERVED]** — full authoring form, Hard/Weight and Offset/Optimal-Spacing modes resolved |
| Staff rules | **[OBSERVED]** — full authoring form, five THEN-action types, Staff-Balance-conditioned IF clause |
| Optimization settings | **[OBSERVED]**, distributed rather than centralized |
| Schedule-generation controls | **[OBSERVED]** (Build Setup fields) |
| Build history | **[OBSERVED]** |
| Build status | **[OBSERVED]** (2 states); **[UNRESOLVED]** (intermediate/failure states) |
| Build errors | **[UNRESOLVED]** — none encountered |

---

## Safety & boundary notes

- No configuration was saved anywhere in this phase: Pattern Rule Setup, Staff Rule Setup, Build Setup, Valid Group Setup, and the "Pick Shifts" modal were all opened, inspected, and closed via Cancel without any Save/Create/Update action.
- The Build Setup screen's chip lists (Staff, Shifts, Shift Groups, Pattern Rules, Staff Rules, Valid Groups) were read but no chip was added or removed.
- "Planner" was clicked once (on an already-Setup build) and produced no visible navigation; this was not retried with a mutating action (e.g., "Save & Generate Planner") to force it open, since doing so would itself be a configuration change.

## Evidence & follow-up

- Screenshots not yet exported to disk (standing limitation).
- Findings merged into [source-page-index.md](source-page-index.md), [unresolved-questions.md](unresolved-questions.md), [evidence-register.md](evidence-register.md), [manifest.json](manifest.json).
