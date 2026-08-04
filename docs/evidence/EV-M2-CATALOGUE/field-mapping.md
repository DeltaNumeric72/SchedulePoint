# Field mapping — the owner's observed-concept list → this schema

**OPUS-M2-002 · the deliverable of record.** Every concept in the owner's binding
list (packet 30 §OPUS-M2-002, *Product requirements*) mapped to the column or
mechanism that carries it, with **every deliberate divergence from the legacy
shape stated and justified**.

**Zero concepts are dropped.** Where a concept is carried by something other than
a column of its own, the row says so and says why. Where the mapping is
`DIVERGENCE`, the reason is a product or safety reason, never convenience.

Source of the observed inventory: `schedulepoint-research/reports/01-application-map.md`
§ADM-07/08/09 and `05-scheduling-engine.md` §1 — read-only reference. **No legacy
column name, table shape or organization/site/person name is reproduced anywhere
in the migration, the code, the fixtures or the tests.**

---

## 1. Shift types (ADM-07)

| # | Owner's concept | Carried by | Notes |
|---|---|---|---|
| 1 | **Short name** | `shift_types.code` (`text`, ≤ 24, `UNIQUE (organization_id, group_id, code)`) | The code shown in grids. **Not updatable** — it is excluded from the column-level UPDATE grant and from `updateShiftTypeRequestSchema`. A code is cited by every grid, report and audit row; a silent rename would corrupt every citation while each still looked correct (non-bypass rule 13's shape, reached through tenant data) |
| 2 | **Full name** | `shift_types.name` (`text`, ≤ 120) | Freely renameable — it is the human label, not the identifier |
| 3 | **Description** | `shift_types.description` (`text NULL`) | `CHECK` refuses whitespace-only: a description that is a space is a description nobody wrote |
| 4 | **Colour metadata** | `shift_types.display_palette_key` (`text`, CHECK-constrained to six curated keys) | **DIVERGENCE — a token key, never a colour value.** A free hex column would let an administrator author an unreadable shift type and **no accessibility gate anywhere could catch it**: the value arrives after the build, and axe only sees what is on the page. The six keys resolve to token pairs whose contrast is computed (`contrast.txt`, 7.78:1 – 10.59:1) and **rendered**, so axe measures every one (SPEC-14: an unrendered pair is unverified) |
| 5 | **Typography metadata** | `shift_types.display_text_style` (`text`, CHECK-constrained to `regular`/`bold`/`italic`) | Same discipline. The style is announced as a word beside the badge, so it is legible to a reader who cannot see it applied |
| 6 | **Start day** | `crosses_midnight` + the weekday dimension of `shift_type_weekday_demand` | **DIVERGENCE — no `start_day` column, deliberately.** The observed catalogue has a start time and an end time and no day. A shift's day is already determined by two facts this schema holds: whether the end time belongs to the following calendar day (`crosses_midnight`), and on which weekdays the type is demanded at all (the demand table). A third column would be a third source of truth for a fact the other two already fix, and the three could disagree. Recorded as the packet's own suggested mapping |
| 7 | **Start time** | `shift_types.start_time` (`time`) | Shift-local; resolves against the group timezone (doc 06 §1) |
| 8 | **End time** | `shift_types.end_time` (`time`) + `crosses_midnight` (`boolean`) | **`crosses_midnight` is DERIVED and enforced, never asked.** `crossesMidnight()` computes it from the two times; `shift_types_overnight_shape` refuses any row where the stored flag and the times disagree. The contract has no field for it, so a client cannot send a value that contradicts the times it also sent |
| 9 | **On-call** | `shift_types.is_on_call` (`boolean`) | One of ADM-07's orthogonal flags, kept orthogonal |
| 10 | **Stipend** | `shift_types.attracts_stipend` (`boolean`) | " |
| 11 | **Manual entry** | `shift_types.is_manual_only` (`boolean`) | " |
| 12 | **Daily pick** | `shift_types.is_daily_pick` (`boolean`) | Constrained against `is_manual_only` by `shift_types_manual_excludes_daily_pick`. **Not an invented rule**: ADM-07 defines `Manually` as "assigned only by manual admin action, **not via the picklist draft**", so both being true contradicts the definition of one of them |
| 13 | **Statistics visibility** | `shift_types.include_in_statistics` (`boolean`) | **Deliberately NOT constrained against `is_leave_of_absence`.** It is tempting — counting an absence as a staffing contribution looks wrong — but the research records the flags as independent and says nothing about their interaction. Constraining them would convert an absence of evidence into a rule (CLAUDE.md §2) |
| 14 | **Leave of absence** | `shift_types.is_leave_of_absence` (`boolean`) | See above |
| 15 | **Report ordering** | `shift_types.report_order` (`integer ≥ 0`) | The list's default sort key (`ORDER BY report_order, code`) |
| 16 | **ON request eligibility** | `shift_types.allow_on_request` (`boolean`) | Enforced data now; the request LIFECYCLE is M5. See §5 |
| 17 | **OFF request eligibility** | `shift_types.allow_off_request` (`boolean`) | " |
| 18 | **Optimization weight** | `shift_types.credit_weight` (`numeric(8,3)`, 0–1000) | `numeric`, not float: a fairness credit off by a rounding error is a fairness complaint nobody can answer |
| 19 | **Archiving** | `shift_types.status ∈ {active, retired}`, plus **no DELETE grant** and composite child FKs that are **`NO ACTION`** (PostgreSQL's default — no referential action is declared) | Two independent controls, both proven (`named-proofs.txt`, proof 1): the application cannot delete (42501) and **the table owner cannot delete a referenced row either** (23503). Retirement keeps every reference resolvable. **`NO ACTION`, not `RESTRICT`** — an earlier version of this row said RESTRICT and was simply untrue of the SQL. The two are equivalent for this purpose: both raise `23503` on a DELETE whose row is still referenced, and they differ only in when the check runs (`NO ACTION` is deferrable and evaluated at end of statement, `RESTRICT` is immediate). **Nothing here defers a constraint**, so the difference has no effect |
| 20 | **Effective dating** | `shift_types.effective_from` / `effective_to` (`timestamptz`), finite-bounded, **authorable** via `effectiveFrom`/`effectiveTo` on the create and update contracts | **The concept splits in two, and only the first half is in this slice.** See the note below |

### Row 20 in full — what effective dating IS here, and what is carried forward

An independent review found the original implementation was **`created_at` in
disguise**: the columns existed, but no contract accepted a window, so
`effective_from` could only ever be "now", and nothing read the window at all.
Fable's ruling splits the concept, and the split is recorded here rather than
implied:

| Half | Status |
|---|---|
| **Authoring the window** | **IN this slice.** `createShiftTypeRequestSchema` and `updateShiftTypeRequestSchema` accept optional `effectiveFrom` / `effectiveTo`; the service passes them through; `effectiveWindowProblems` refuses a backwards window and an infinite bound (0002's S-22), naming the field. A future-dated definition round-trips — proven in `apps/api/test/catalogue/review-findings.test.ts` |
| **In-force READ filtering** | **CARRIED FORWARD to M4**, where the catalogue becomes engine input and the shared in-force loader from OPUS-M2-003 applies. A second implementation here would be the thing that pattern exists to prevent |

**The authoring list returning every definition — future-dated and expired
alike — is intentional and stays.** An administrator preparing next quarter's
rota must be able to see and edit a definition that is not in force yet; a list
that hid it would make it uneditable, which is the opposite of what effective
dating is for.

Two further points kept from the original row, both still true. **DIVERGENCE
from an EXCLUDE-per-code model:** doc 06 §3.2 gives the uniqueness as
`(group_id, code)` and this keeps it literally — a code is a group's permanent
name for a kind of work and is never re-issued, so the window lives on the one
row rather than producing a row per version. **Retirement closes the window**
(`effective_to` set alongside `status`), unless the caller named a date, in
which case the caller's date wins.

## 2. Weekday and holiday demand (owner-mandated in this slice)

| # | Owner's concept | Carried by | Notes |
|---|---|---|---|
| 21 | **Weekday demand** | `shift_type_weekday_demand (shift_type_id, day ∈ {mon..sun}, demand_count ≥ 0)` | Unique `(organization_id, group_id, shift_type_id, day)` — the tenant-qualified key is also the upsert's conflict target, so an upsert can only ever match a row in the caller's own group |
| 22 | **Holiday demand** | the same table, `day = 'holiday'` | **DIVERGENCE — `holiday` is a NINTH member of the day enumeration, not a boolean.** Holiday demand *replaces* the weekday figure rather than modifying it; a boolean would have produced eight rows with an ambiguous precedence rule, and a ninth day value produces eight rows with none. Which dates are holidays is `group_holidays` |

## 3. Shift groups (ADM-08)

| # | Owner's concept | Carried by | Notes |
|---|---|---|---|
| 23 | **Bundle of shift types** | `shift_groups` + `shift_group_members` (CAP-012's own named structure, doc 18) | De-bundling is `is_active = false`, never a DELETE: no runtime role holds one, and a bundle's composition at the time a schedule was built is part of explaining that schedule |
| 24 | **Optimization flags** (scoring mode) | `shift_groups.scoring_mode ∈ {hard, weighted}` | **DIVERGENCE — the observed "Hard (0)" display is NOT reproduced.** Research 05 §1 resolved it: Hard is a non-negotiable constraint and the zero is a display convention for "not weighted", not a value. `shift_groups_scoring_shape` makes the weight present exactly when the mode is `weighted`, mirroring the `rules` table's hard/soft CHECK (CAR-006), and the contract's discriminated union makes `{ scoringMode: 'hard', weight: 0 }` a parse error |
| 25 | **Optimization weights** | `shift_groups.weight` (`numeric(10,3) NULL`) | NULL exactly when `hard`. Observed "Linear (1000)" is a weighted bundle with weight 1000 |
| 26 | **Request eligibility (bundle)** | `shift_groups.allow_request` (`boolean`) | ADM-08's "Allow Request" |
| 27 | **Request text** | `shift_groups.request_off_label` (`text NULL`) | **Kept on the SHIFT GROUP, per the observed model** — this is the packet's stated expectation and the research agrees ("staff requests are frequently made against a Shift Group"). `shift_groups_request_label_shape` requires it exactly when `allow_request`: a request-off control with no label is a control nobody can describe, and a stale label on a bundle that no longer accepts requests is a lie waiting to be re-enabled |

## 4. Staff groups, valid combinations, pick positions, holidays

| # | Owner's concept | Carried by | Notes |
|---|---|---|---|
| 28 | **Staff groups** (ADM-06) | `staff_groups` + `staff_group_members` | Deliberately separate from shift groups (report 19 CAP-012: "SchedulePoint separates them explicitly"); they bundle different things for different reasons and share no field beyond a name |
| 29 | **Valid combinations** (ADM-09) | `valid_groups` + `valid_group_shift_types` + `valid_groups.allowed_pick_positions integer[]` | **DIVERGENCE, and the asymmetry is deliberate.** The shift-type half is a child table with a composite FK, because a shift type is a row and the FK is what makes archive-not-delete true at the database. The position half is an array on the row, because a pick position is not an entity anywhere in this schema — it is an ordinal — and a child table of integers would invent an aggregate nothing references. doc 06 §3.2 models it as `allowed_pick_positions` for the same reason |
| 30 | **Pick-position count** (ADM-07 "Pick Shifts") | `groups.pick_position_count` (`integer ≥ 0`), **monotonic, trigger-enforced** | The observed constraint verbatim: the count "may only be increased… These may not be deleted in the future." `app_guard_group_pick_position_count` refuses a decrease with `restrict_violation`, and `app_guard_valid_group_positions` refuses a `valid_groups` row naming a position above the ceiling. Proven under two concurrent backends (`named-proofs.txt`, proof 2): the later, lower write is refused and the stored count never falls |
| 31 | **Holiday calendar** (CAR-011) | `group_holidays (holiday_date, name, observed)`, unique `(organization_id, group_id, holiday_date)` | What makes the `holiday` demand day mean actual dates, and what "the deadline is Friday" is resolved against. `observed` distinguishes a holiday the group records but works through |

## 5. What is DATA now and BEHAVIOUR later — stated, not implied

`allow_on_request` and `allow_off_request` (rows 16–17) and `shift_groups.allow_request`
(row 26) land as **enforced data**: they are stored, constrained, audited, and
returned by the surfaces that exist. The **request lifecycle** — submitting,
approving, consuming a request — is M5 and no part of it is implemented here.
The packet requires this to be said in the report and it is said here too.

Likewise `shift_type_weekday_demand` is the **catalogue-authored default**. Per
FAD-16, build-scoped demand overrides remain M4 scope.

## 6. Deliberately NOT created

| Thing | Why |
|---|---|
| `shift_type_qualifications` | Integration-packet scope (packet 30 §5). Not created, not referenced |
| A `start_day` column | Row 6 |
| A free colour value | Row 4 |
| A `holiday` boolean beside the weekday | Row 22 |
| A read capability (`schedule.catalogue.read`) | Inventing one means inventing which roles hold it, and doc 08 §6 has no "view catalogue" row to read that off. Deny-by-default is the correct direction to be wrong in (I-02); the later surfaces that need to READ shift types declare their own actions when they ship. Recorded in `INDEX.md` §Limitations |
