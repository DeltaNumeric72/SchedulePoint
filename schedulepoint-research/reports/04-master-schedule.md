# 04 — Master Schedule & Manual Scheduling: ischedule.MD

**Phase:** 5 — deep dive on the Master Schedule system.

**Method:** Read-only per [RESEARCH-RULES.md](../RESEARCH-RULES.md). Menus, cell editors, and modals were opened for inspection only; every mutating control (Move Shift, Move Credit, Add, Batch Add/Delete, Save on the Staff Balance modal) was left unclicked, and every modal was dismissed via Close/Cancel. Merges by stable ID into [01-application-map.md](01-application-map.md) (SCH-02/03/04) and [03-user-workflows.md](03-user-workflows.md) (WF-05/WF-05a) rather than redescribing them.

**Evidence labels:** **[OBSERVED]** · **[INFERRED]** · **[UNRESOLVED]**.

**Exclusions honored:** all cell-editor audit-log examples below use anonymized placeholders (Staff-A, Staff-B, …) — no real names from the log are reproduced.

---

## 1. Views (SCH-02/03/04 recap + this phase's additions)

| View | Rows | Columns | Cells | New this phase |
|---|---|---|---|---|
| **Date View** (default) | summary metrics + staff | dates | pick-order label or shift code | clicking a cell opens the full **cell editor** (§3) |
| **Staff View** | dates | staff | pick-order label or shift code | shift-code legend printed below grid (30 codes seen — full legend now captured, see §7) |
| **Shift View** | named shift/role slots | dates | assigned staff | unchanged from Phase 1 |

Switching is via the **Date View ▾** control; state is carried in the URL hash (`view=date\|staff\|shift`), alongside `weeks=`, `begin=`, `batch=`, and `buildState=`.

## 2. Date ranges, filters, paging, highlighting, legends

- **Date range:** `1 Week`–`8 Weeks` stepper; **[OBSERVED]** unchanged from Phase 1.
- **Filters:** `All Shifts / Assigned / Scheduled` — client-side, confirmed by URL/network behavior not changing on toggle. **[OBSERVED]**
- **Paging:** Prev/Today/Next steppers + a full calendar-month **Date ▾** picker. **[OBSERVED]**
- **Highlighting:** in Staff View, the **"Month - Click to Highlight"** and **"Week - Click to Highlight"** header rows (documented in Phase 1 for Vacation; the same interaction pattern exists on Master Schedule's own header rows) allow highlighting an entire month or week column for visual scanning — a display-only aid, no data effect. **[OBSERVED label; INFERRED as purely visual — not clicked this phase]**
- **Legends:** the `*daily picks*` row (which shift categories are offered in each day's picklist draft) and the shift-code legend beneath Staff View. Full legend this phase (30 codes, generic operational vocabulary, safe to reproduce in full):

  `OB DAYCALL, ORC, OBC, BKAM, BKPM, WEDAY, ORSUN, OB PM, ENDO WE, CVCALL, CVWE, CSICU, CV1, CV2, CV3, CVCLI, CLIN AM, DAYOFF, CLIN PM, QREG, TAVI, TAVI 2, PTD, CONF, OFF, POST`

  (each maps to a full name, e.g. `ORC = OR Call`, `OFF = Vacation`, `PTD = Part Time Group`, `POST = POST CALL` — matches the Shifts catalog, ADM-07)

## 3. Cell interactions (major finding this phase)

Clicking any staff/date cell in **Date View** opens a modal titled **"`<Staff Name>` - `<Date>`"** (confirmed on the reviewing account's own cell; **[UNRESOLVED]** whether it opens identically for other staff's cells — not tested, to avoid any risk of an accidental edit landing on someone else's record).

### 3.1 Display: Shifts vs. Credits (new finding)

A **"Display"** selector (custom widget, two options) toggles the modal between two independent editable dimensions of the same cell:

- **Shifts** mode: shows the cell's shift/pick label (e.g. "5th Pick") with a **Move Shift** button.
- **Credits** mode: shows **"`<label>` — Credit: `<Staff Name>`"** with a **Move Credit** button instead.

**This is a significant data-model finding:** the *actual shift assignment* and the *fairness credit* for that slot are **stored and moved independently**. Moving a shift (who does the work) is a distinct operation from moving a credit (who gets scored for it) — directly explaining why Shift Statistics (ADM-04) separately tracks "Credits" vs. "Actual Shifts," and why Shift Groups (ADM-08) needed their own "Equation & Weight" credit system distinct from the raw schedule. **[OBSERVED — high confidence]** Neither Move Shift nor Move Credit was clicked.

### 3.2 Add a shift/pick to the cell

A **"Type shift to add…" + Add** control at the top of the modal (both Shifts and Credits modes) lets an admin add an additional shift/pick to that staff member's day without going through Picklist Manager. A visible **⚠ warning note** — *"Move picks when possible, use Picklist Control to add or delete picks"* — signals this direct-edit path is a secondary/fallback mechanism, and the product's own guidance steers admins toward the Picklist Manager (PLM-01) for the primary add/delete workflow. **[OBSERVED]** Not exercised.

### 3.3 Audit/provenance log (the most valuable finding of this phase)

Below the Move controls, every cell modal shows a **reverse-chronological, plain-language change log** for that specific cell. Confirmed entry shapes **[OBSERVED]**, with placeholders substituted for real names:

- `"<Shift> moved as opportunity to Staff-B by Staff-B." <timestamp>` — a self-service give-away (Phase 4's WF-11) logged in the shift's own history, phrased as the *recipient* acting, not the original poster — **[INFERRED]** this means the log records the claim event, attributed to whoever ended up with the shift, not the person who posted it.
- `"<Nth> Pick changed to <Nth> Pick by Staff-C (PLC)." <timestamp>` — a pick-order change made through the picklist/pick interface itself (tag `PLC`, most plausibly "Pick List Control").
- `"<Nth> Pick reassigned to Staff-D by Staff-E." <timestamp>` (no tag) — an admin-driven reassignment via this same Master Schedule cell editor, or an equivalent admin tool.
- `"<Shift> reassigned to Staff-D by Staff-E." <timestamp>` — the shift-level equivalent of the above.

**Given/When/Then:**
> **Given** a staff member's pick has been moved, reassigned, or given away one or more times
> **When** any user with cell-editor access opens that cell
> **Then** the modal displays a complete, timestamped, human-readable history of every such change, each entry naming the actor and (where applicable) a mechanism tag distinguishing self-service picklist actions from admin-driven ones

**Confidence:** High for the log's existence, shape, and the four action-phrasings observed. **[UNRESOLVED]**: (a) whether the log is exhaustive of literally every change type the system supports (e.g., does an "Erase Master Schedule" or a Build "Publish" leave any trace here, or only cell-level moves?); (b) whether staff can view this log for their own cells unassisted, or it's admin-only (this session is Scheduler-level, so a lower-privileged view was not testable); (c) whether the log is per-cell only or can be queried/exported in aggregate anywhere (no such aggregate view was found in this or prior phases).

## 4. Assignments, credits, OFF/vacation entries, counts and balances

- **Assignments:** a cell's shift code (e.g. `CV2`, `TAVI`) or a numbered pick-order label (e.g. "5th") — the two are mutually exclusive display states depending on whether the picklist for that day has resolved yet (see Phase 4 WF-04's "Not picked yet" finding, which applies identically here).
- **Credits:** see §3.1 — a separate movable value per cell, distinct from the assignment itself.
- **OFF/vacation entries:** rendered as `OFF` in green; cross-references the Vacation module (VAC-01) — the "Vacation shift" setting on Group Settings (ADM-01) determines which shift code renders vacation on this grid.
- **Counts and balances [OBSERVED, recap from Phase 1 with confirmed formula]:** **Staff Balance** = Staff Available − Daily Picks − Operating Rooms, shown per date; clicking it opens an editable modal (Operating Rooms is the only directly-editable term; the other two are computed). **Pick List Control** = a count tied to picklist state for that day. **Requests** = a count with a hover/click tooltip surfacing a compact requester+status+target-shift-group record (ties directly to Phase 4's WF-08/WF-10 request records).

## 5. Notes, holidays, calendar events

- **Notes/Holiday row:** a per-day comment-count badge; clicking opens a small modal (confirmed in Phase 1) showing the Staff Balance breakdown fields (Staff Available, Daily Picks read-only, Operating Rooms editable, computed Staff Balance) plus Close/Save. **[OBSERVED]**
- **Calendar events row:** present as a header row in every view; no populated example was encountered in the date ranges browsed this phase, so its click-through content remains **[UNRESOLVED]**.
- **Holidays:** referenced structurally throughout (Pattern Rules' `ALL+HOLIDAYS` day-scope, Group Settings' `OR Daily Defaults` having a distinct `Holidays` column, Staff Shift FTE's `Hol` quota column) but no dedicated "holiday calendar" admin screen was found in this or prior phases — holidays appear to be a recognized day-type baked into the scheduling engine's day-of-week model rather than a separately manageable list. **[INFERRED]**

## 6. Requests and daily picks (on the grid)

Already covered: the `Requests` row/tooltip (§4) and the `*daily picks*` row (§2). No new interaction beyond what Phase 1/4 already captured.

## 7. Picklist controls and batch tools (recap, no new findings this phase)

- **Pick List Control** count (§4), tied to Picklist Manager (PLM-01).
- **Batch Mode ▾** → **Batch Delete / Batch Add** — bulk mutating tools, confirmed present, deliberately never opened past the dropdown label (see 01-application-map.md §"Batch Mode" — Phase 1 already inspected the dropdown itself; this phase did not re-open it).
- **Print ▾** → Schedule/Picklist/Stipend/Requests export types — unchanged from Phase 1, not exercised.

---

## 8. Draft and published behaviour

This is largely **[INFERRED]** from Builds (ADM-02) and the Build Editor (see 05-scheduling-engine.md for full detail); the Master Schedule itself does not expose an explicit "draft vs. published" toggle on its own UI. Key cross-references established this phase:

- The Master Schedule URL carries a `buildState=all` parameter at all times observed — **[UNRESOLVED]** whether other values (e.g. a specific build ID, or a "draft only" filter) are reachable through any visible control; none was found. This parameter may simply mean "show the currently-published state regardless of which build produced it," with draft-only viewing available exclusively through the Builds pipeline's own Setup/Planner/Build screens rather than through Master Schedule directly. **[INFERRED, low confidence]**
- **Unsaved changes:** the cell editor's Move Shift/Move Credit/Add controls appear to act immediately on click (no separate "unsaved draft, click to commit" state was observed in the modal itself) — **[INFERRED]** each action in this modal is likely an immediate, individually-committed change (consistent with each one being independently logged in the audit trail with its own timestamp, §3.3), rather than a batch of pending edits requiring a separate save step. Not verified by executing an edit.
- **Saving with/without notifications:** **[UNRESOLVED]** — no visible toggle for "notify on this change" was found on the cell editor; Picklist Manager's per-list **Email** button (PLM-01) is the only explicit, visible notification trigger found anywhere in the scheduling-admin surface.
- **Discard behaviour:** **Close Window** and **Cancel** buttons throughout appear to simply close without persisting whatever was typed into an unsubmitted field (e.g., a "Type shift to add" value never clicked to Add) — **[INFERRED]**, consistent with ordinary web-form behavior, not specifically confirmed by re-opening after a typed-but-uncommitted edit.
- **Post-publication changes:** the cell editor was reachable and appeared fully interactive on the *currently active* schedule (this tenant's live Master Schedule) — **[OBSERVED]** — meaning direct cell edits remain possible on a schedule that is presumably already "published" in the Build sense, unless the underlying Build has additionally been explicitly **Locked** (ADM-02). This suggests two independent gates: Build-level Lock/Unlock (coarse, per date-range) and no additional per-cell lock observed.
- **Staging behaviour / publication prerequisites / incomplete schedules / locking behaviour / rollback or unpublish evidence:** all substantially covered by the Builds pipeline rather than the Master Schedule screen itself — see 05-scheduling-engine.md §"Build lifecycle" for the full writeup; summarized here only where it touches Master Schedule directly:
  - A build's **Lock** state (ADM-02) is the only lock/unlock mechanism found; once Locked, a build row shows only an "Unlock" control, with no Setup/Planner/Build/Fix Picks/Publish buttons — **[OBSERVED]** — implying the underlying schedule data for that period becomes protected from the pipeline (though whether direct Master Schedule cell edits are *also* blocked once the source build is Locked was **not tested**, since doing so would require attempting an edit on a locked period's cell, which risks an actual mutation. **[UNRESOLVED, deliberately untested]**
  - No explicit "rollback" or "unpublish" button was found anywhere; **Unlock** is the closest control to a reversal, and it reverses the *lock*, not necessarily the published content itself. **[UNRESOLVED]**

### Given/When/Then — draft/publish behaviour (confirmed portions only)

> **Given** a Build's Lock state is "Locked"
> **When** an admin views that build's row in the Builds list
> **Then** only an "Unlock" control is shown; Setup, Planner, Build, Fix Picks, and Publish are not available for that row

> **Given** a Master Schedule cell belongs to a date range whose Build is not Locked
> **When** an admin (Scheduler-level, confirmed) opens that cell
> **Then** the cell editor loads fully interactive, offering Move Shift, Move Credit, and Add, alongside the complete change-history log for that cell

## 9. User visibility

- Master Schedule content is visible at minimum to the Scheduler-level account used throughout this review, across both of its groups. **[OBSERVED]**
- Whether Staff/Locum/View/Telecom-level accounts see the same grid (read-only, presumably) or a restricted subset (e.g., only their own row, or only certain shift types) remains **[UNRESOLVED]** — no lower-privileged session was available to test, consistent with every prior phase's limitation.

## 10. Permissions and validation

- No client-side validation was observed to be exercised (no edit was submitted), but the modal itself enforces structural constraints via its UI shape (e.g., Move Shift requires a staff selection before the button is meaningfully actionable — **[INFERRED]**, button was not clicked to confirm whether it's disabled without a selection).
- Permission gating for who can open the cell editor at all is **[INFERRED]** to follow the same Access-Level model documented in 02-role-permission-matrix.md (Scheduler/Genius likely required), not independently re-derived this phase.

## 11. Observable audit or provenance information

Covered fully in §3.3. This is the single richest piece of evidence this phase produced and is flagged as a **must-carry-forward concept for SchedulePoint's own data model**: every schedule mutation should be independently attributable, timestamped, and human-readably describable, scoped to the specific cell/slot it affected, and should distinguish self-service (picklist-driven) changes from admin-driven ones via some equivalent of the observed `(PLC)` tag.

---

## Master checklist — Phase 5 topics

| Topic | Status |
|---|---|
| Date View / Staff View / Shift View | **[OBSERVED]** — §1 |
| Date ranges/filters/paging/highlighting/legends | **[OBSERVED]** — §2 |
| Summary information | **[OBSERVED]** — §4 |
| Cell interactions | **[OBSERVED]** — §3 (major new finding: Shifts/Credits split + audit log) |
| Header interactions | **[OBSERVED]** (highlight rows) / **[UNRESOLVED]** (calendar events content) — §2, §5 |
| Assignments / credits / OFF-vacation / counts-balances | **[OBSERVED]** — §4 |
| Notes / holidays / calendar events | **[OBSERVED]** (notes) / **[INFERRED]** (holidays, no dedicated screen) / **[UNRESOLVED]** (calendar events content) — §5 |
| Requests / daily picks | **[OBSERVED]** — §6 |
| Picklist controls / batch tools | **[OBSERVED]** (existence) — §7 |
| Draft/published behaviour | **[INFERRED]**, largely deferred to 05-scheduling-engine.md | §8 |
| Unsaved changes / save w/ or w/o notifications / discard | **[INFERRED]** — §8 |
| Post-publication changes / staging / prerequisites / incomplete schedules | **[INFERRED]** — §8 |
| Locking behaviour | **[OBSERVED]** at Build level; **[UNRESOLVED]** at cell level once source build is Locked | §8 |
| User visibility | **[OBSERVED]** for Scheduler only; **[UNRESOLVED]** for other roles | §9 |
| Rollback/unpublish evidence | **[UNRESOLVED]** — no such control found | §8 |
| Permissions/validation | **[INFERRED]** | §10 |
| Audit/provenance | **[OBSERVED]**, extensively — §3.3, §11 |

---

## Safety & boundary notes

- Move Shift, Move Credit, and Add were never clicked; the "Type shift to add" and "Staff for move shift or credit" fields were never filled and submitted.
- The cell editor was only opened on the reviewing account's own row, never on another staff member's cell, to avoid any risk of an accidental edit landing on someone else's schedule.
- Batch Mode's Batch Add/Batch Delete were not re-opened this phase (already noted as existing in Phase 1; not re-tested).
- All audit-log names are anonymized in this report; no real staff name from any log entry is reproduced.

## Evidence & follow-up

- Screenshots not yet exported to disk (standing limitation).
- New findings merged into [source-page-index.md](source-page-index.md), [unresolved-questions.md](unresolved-questions.md), [evidence-register.md](evidence-register.md), [manifest.json](manifest.json).
