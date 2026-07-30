# 01 — Application Map: ischedule.MD

**Method:** Clean-room, read-only exploration of a live, signed-in production instance of ischedule.MD (physician workforce scheduling for an anesthesia department, tenant: a hospital network with at least two sites/groups). Purpose: build an independent understanding of observable screens, workflows, terminology, and rules so a new, independently-designed product (SchedulePoint) can support the same *categories* of user need without copying source code, assets, or data.

**Evidence labeling used throughout:**
- **[OBSERVED]** — seen directly on screen (label, control, behavior, URL).
- **[INFERRED]** — reasonably concluded from observed evidence but not directly confirmed (e.g., clicking a "Save"/"Delete" button was deliberately avoided).
- **[UNRESOLVED]** — open question; needs a follow-up read-only look or cannot be determined without a mutating action.

**Exclusions (by design, per instructions):** No patient information, no real staff names/emails/phone numbers, no source code, no credentials/tokens were copied into this report. Where a screen displayed such data (staff directory, on-call phone numbers, per-case surgical detail), this report describes the *feature and schema* generically instead of transcribing the values. See "Safety & boundary notes" at the end for the one near-miss encountered and how it was handled.

**Screenshot evidence:** Screenshots were viewed and inspected in-session but were **not** exported to disk during this pass (see [unresolved-questions.md](unresolved-questions.md)). The `screenshot_ref` field below is a logical ID for a future capture pass (path under `schedulepoint-research/screenshots/<area>/`), not a file that exists yet.

---

## 1. Site identity & tenant context

- Product name: **ischedule.MD** — "Physician scheduling software specializing in Anesthesia with mobile picklist online cloud" (browser tab title, [OBSERVED]).
- Marketing homepage (unauthenticated, `/`) pitches: complex rules, requests, staffing needs, "keep it fair," an "80% reduction in schedule creation/maintenance effort," a "unique picklist algorithm," "optimal call spacing algorithm," and "mobile picklist." [OBSERVED]
- Authenticated app is tenant-scoped via a `groupId` query/hash parameter (e.g. `#groupId=8`). The signed-in account belongs to **two groups/sites** under one hospital network, switchable from a top-nav dropdown ("THP C Site" / "THP M/Q Site"). [OBSERVED] This confirms a **multi-site / multi-group tenancy model** where one user account can hold membership (and possibly different roles) in more than one scheduling group. [INFERRED: role may differ per group]

---

## 2. Information architecture (navigation map)

### 2.1 Top bar (present on every authenticated screen)
| Control | Target | Notes |
|---|---|---|
| Logo | `/` | marketing home |
| Tour | client-side action | Guided tour trigger; did not visibly launch on repeated click — [UNRESOLVED] whether it's page-specific or first-login-only |
| Dashboard | `/admin/picklistmonitordashboard` | "Active Pick Lists" live monitor, admin-oriented |
| Site switcher ("THP … Site ▾") | dropdown | Lists all groups the user belongs to; switches tenant context |
| User menu (user's display name ▾) | dropdown | **My Profile**, **Notification Settings**, **Sign In As**, **Sign Out** |
| Clock | display only | live-updating current date/time, top-right of content area on every screen |

**"Sign In As"** [OBSERVED label only] — strongly implies an **impersonation / "log in as another user"** capability, presumably restricted to admin/scheduler roles. Not exercised (would be a mutating/identity-changing action). [INFERRED feature; UNRESOLVED scope/permission gating]

### 2.2 Left sidebar (primary nav)
Fixed order, icon + label, current section highlighted:

1. **My Schedule** — `/app`
2. **Master Schedule** — `/app/schedulenew`
3. **On Call** — `/app/oncalltoday`
4. **Vacation** — `/vacation/index`
5. **Daily Assignments** — `/app/viewplm`
6. **Choose List** — `/app/picklist`
7. **Contacts** — `/app/contacts`
8. **Documents** — `/app/documents`
9. **Picklist Manager** — `/admin/picklists`
10. **Scheduling** (expandable accordion, admin-only content) — `/admin/*`
11. **Support** — external link to `ischedulemd.zendesk.com` (Zendesk help center)

All items are visible to the currently signed-in account, which — given access to `Picklist Manager` and the entire `Scheduling` admin accordion — appears to hold an **elevated (scheduler/admin-level) role**, not a plain staff role. [INFERRED — see Role Model, §5]

### 2.3 "Scheduling" admin accordion (sub-nav)
> **Corrected in Phase 3** ([02-role-permission-matrix.md](02-role-permission-matrix.md) §1): this list had 10 items; an 11th, "Staff Rules," was missed. See ADM-11 in the Phase 3 report.

1. Group Settings — `/admin/groups`
2. Builds — `/admin/builds`
3. Staff Shift FTE — `/admin/staffshiftfte`
4. Statistics — `/admin/shiftstatistics`
5. Staff — `/admin/users`
6. Staff Groups — `/admin/staffgroup`
7. Shifts — `/admin/shifts`
8. Shift Groups — `/admin/shiftgroup`
9. Valid Groups — `/admin/validgroups`
10. Pattern Rules — `/admin/patterns`
11. **Staff Rules — `/admin/staffrules`** (ADM-11, see [02-role-permission-matrix.md](02-role-permission-matrix.md))

---

## 3. Screen inventory

Each record: **ID | Name | URL | Nav path | Purpose | Likely roles | Key sections/controls | Related screens | Open questions | screenshot_ref**

### NAV-01 — Top bar
- **URL:** all pages (persistent chrome)
- **Purpose:** global context switching, identity, help entry point, tour re-launch.
- **Roles:** all authenticated roles (contents may vary by role — [UNRESOLVED])
- **Controls:** Tour, Dashboard, Site switcher, User menu (My Profile / Notification Settings / Sign In As / Sign Out)
- **Related:** SYS-02 (user menu), SYS-01 (site switcher)
- **Open questions:** Does a plain "Staff" role see the same top bar (Dashboard, Sign In As) as the current elevated account? [UNRESOLVED]
- **screenshot_ref:** `screenshots/navigation/nav-topbar-01.png`

### NAV-02 — Left sidebar
- **URL:** all pages
- **Purpose:** primary IA / section switching
- **Roles:** varies — admin-only items (Picklist Manager, Scheduling) likely hidden for plain staff [INFERRED]
- **Controls:** 11 top-level links, 1 expandable accordion (10 sub-items)
- **Related:** every screen below
- **Open questions:** Exact per-role visibility rules [UNRESOLVED]
- **screenshot_ref:** `screenshots/navigation/nav-sidebar-01.png`

### SCH-01 — My Schedule
- **URL:** `/app`
- **Nav path:** Sidebar → My Schedule
- **Purpose:** individual staff member's personal calendar/dashboard: assigned shifts, upcoming picklist opportunities, personal requests status.
- **Roles:** all authenticated users (personal, self-scoped view)
- **Sections:**
  - Month calendar grid (Mon–Sun columns), each day cell shows shift-code(s) plus a numeric "position" label (e.g. "5th", "17th", "21st") that appears to correspond to the staff member's rank/position in that day's pick order — see PLM-01. [INFERRED]
  - Controls: Print, Subscribe (iCal-style feed per marketing copy "subscribe … with iCal" [OBSERVED marketing claim]), Date-picker, Prev/Today/Next
  - **Date Details** side panel: mini date-strip selector, **Swap Shift** button (shift-swap workflow entry point — not exercised), **Today's Shifts** — for a day with clinical assignments this expands into a **case-level work list** (the schema includes: shift code, and a line per case). *(Content here can include clinical case detail — this report does not reproduce it.)* A note "* POST DAILY PICKS (ADMIN ONLY) *" appears, implying a permission-gated action embedded contextually in this panel. [OBSERVED label; INFERRED meaning]
  - **Opportunity Board** — list of future dates with an open "pick" opportunity (e.g., a numbered position becoming available for anyone to claim), format "`<Month Day (Weekday)>` — `<Nth> Pick`". This is the **shift-opportunity / swap marketplace** referenced in marketing copy ("post shifts to the opportunity board"). [OBSERVED]
  - **My Requests** panel — header shows a state, e.g. "(CLOSED)", with a **PENDING** toggle/filter button, and a body table (empty for the viewed period). Implies requests have at least two visible states surfaced here: a submission-open/closed window state, and individual request statuses (pending vs. resolved). [INFERRED — see Requests workflow, §6.3]
- **Related screens:** SCH-02/03/04 (Master Schedule — the org-wide equivalent), DA-01 (Daily Assignments), VAC-01 (own vacation appears here as "OFF")
- **Open questions:** What does "Swap Shift" open (a modal? a request to a specific colleague)? Who can see/claim Opportunity Board entries — anyone, or only same-shift-group-eligible staff? [UNRESOLVED]
- **screenshot_ref:** `screenshots/schedule/my-schedule-01.png`

### SCH-02/03/04 — Master Schedule (Date View / Staff View / Shift View)
- **URL:** `/app/schedulenew` (state kept in URL hash: `weeks`, `view`, `begin`, `batch`, `buildState`)
- **Nav path:** Sidebar → Master Schedule
- **Purpose:** org-wide schedule grid across the whole staff group, for a selectable date range.
- **Roles:** appears to be a scheduler/admin-facing screen (batch edit tooling present) but could be read-only for staff — [UNRESOLVED]
- **Sections / controls:**
  - **View mode** toggle: **Date View** (rows = metrics/summary + staff, columns = dates), **Staff View** (rows = dates, columns = staff, with a **shift-code legend** printed below the grid), **Shift View** (rows = named shift/role slots, columns = dates, cells = assigned staff). [OBSERVED — all three confirmed by direct interaction]
  - **Batch Mode** dropdown → **Batch Delete**, **Batch Add** (bulk mutating tools; not exercised)
  - **All Shifts / Assigned / Scheduled** filter dropdown (client-side)
  - **Font Size** stepper (display preference)
  - Date range stepper: **1–8 Weeks**
  - **Print ▾** menu → **Schedule / Picklist / Stipend / Requests** (four distinct exportable report types) — not exercised (avoids uncontrolled downloads)
  - **Date** picker (calendar widget) + Prev/Today/Next
  - Summary rows above the grid, per date: **Notes/Holiday** (a comment-count badge, click opens a per-day modal), **Calendar events**, **Staff Balance** (a computed value, colored red/positive; clicking opens an editable modal showing `Staff Available − Daily Picks − Operating Rooms = Staff Balance`, with **Operating Rooms** as an admin-editable count and a **Save** button — confirms Staff Balance is a live *staffing-supply-vs-demand* indicator, not just a label), **Operating Rooms** (editable count), **Pick List Control** (a count, presumed = number of staff still eligible/queued to pick), **Requests** (a count; hovering/clicking a day's request cell surfaces a tooltip with a compact encoded request record, e.g. requester-initials + requested change + the shift-group it targets + an approval-state icon).
  - A **"\*daily picks\*"** row lists, per date, which shift categories are being offered in that day's picklist draft (e.g., categories like clinic AM/PM, endoscopy, on-call, regional coordinator slots — exact codes vary by site config).
- **Data model implication:** the grid is fundamentally a **staff × date × shift-code** matrix; "Shift View" reveals the inverse (shift-slot × date × assigned-staff), meaning shift *slots* (e.g., "Cardiac OR 1", "CSICU Daytime", "Backup PM") are first-class entities distinct from the shift-code abbreviation shown elsewhere.
- **Related screens:** ADM-07 (Shifts catalog defines the codes/slots seen here), ADM-02 (Builds — a Master Schedule is the rendered output of a "Build"), PLM-01 (Picklist Manager — "Pick List Control" ties directly to picklist state)
- **Open questions:** Exact semantics of "Staff Balance" formula beyond the three visible terms; whether "Batch Add/Delete" writes directly to the live schedule or to a draft/build. [UNRESOLVED]
- **screenshot_ref:** `screenshots/schedule/master-schedule-dateview-01.png`, `...-staffview-01.png`, `...-shiftview-01.png`

### SCH-05 — On Call (today card + monthly grid)
- **URL:** `/app/oncalltoday`
- **Purpose:** operational, phone-book-style view of *who is on call right now* and for the rest of the month, per on-call role.
- **Roles:** all users likely (this is the "who do I call" screen); could be read-only for everyone
- **Sections:**
  - "Today" card: one row per on-call **role** (e.g. primary OR call, obstetric call, backup, ICU-adjacent call, daytime ICU coverage), each showing the assigned staff member's name behind a **click-to-call phone chip**. [OBSERVED pattern; names/numbers not reproduced]
  - Monthly grid below: same role columns, one row per day of the month, populated with assigned names.
  - Print button, Date range control.
- **Related screens:** SCH-02/03/04 (same underlying assignments, different presentation), DA-01
- **Open questions:** Does the phone chip actually dial (`tel:`) or just display? [UNRESOLVED, not tested]
- **screenshot_ref:** `screenshots/schedule/on-call-today-01.png`

### VAC-01 — Vacation (staff-facing grid, admin-visible here)
- **URL:** `/vacation/index`
- **Purpose:** track vacation entitlement, requests, and approval state across the group for a defined "vacation block" period.
- **Roles:** clearly admin/scheduler-capable (Approve/Transfer/Batch tools visible) — a plain-staff variant of this screen may differ [UNRESOLVED]
- **Sections/controls:**
  - Banner: "Active vacation block `<start>` to `<end>`" — a configurable global date range (see VAC-02) within which vacation requests are tracked.
  - Toolbar: **Settings** (→ VAC-02), **Batch Entry Off ▾**, **Approve**, **TRANSFER**, **Schedule View ▾**, a **N months** range selector, Date stepper.
  - Header rows: per week-ending date across the active block — **Weekly Quota** (target headcount off that week), **Requested** (count of staff who've requested), and a computed **variance** row (requested − quota, negative in red when over-quota).
  - Grid body: one row per staff member — **Grant** (annual vacation-week entitlement, e.g. 10), **Avail** (remaining balance), then one cell per week showing a colored badge (green vs. amber observed — likely encodes approval status: approved vs. pending) when that staff member has a vacation entry that week.
  - **Clicking a status badge does not open a read-only detail view** — it opens a **"Vacation Block Selection"** modal that defaults straight to a **destructive confirmation**: "Do you wish to delete the week of vacation … for Dr. `<name>`?" with a comments box, a timestamp, and action buttons **Cancel / Save Comment / Remove / Deny**. This was closed via **Cancel** without further action. **This is a notable UX pattern**: there is no neutral "view details" affordance separate from the remove/deny action — the same click surface serves both inspection and deletion. Worth deliberately avoiding this coupling in SchedulePoint's design. [OBSERVED — see Safety & boundary notes]
- **Related screens:** VAC-02 (Settings), SCH-01 (vacation shows as "OFF" on personal schedule), ADM-01 (Group Settings has an overlapping/duplicate notification-escalation config block — [UNRESOLVED] whether vacation notifications reuse the same engine as picklist notifications)
- **Open questions:** What do amber vs. green badges precisely mean (pending vs. approved vs. flagged-conflict)? What does "TRANSFER" do — reassign a vacation slot to another staff member? What does "Batch Entry Off" do exactly? [UNRESOLVED — deliberately not clicked]
- **screenshot_ref:** `screenshots/vacation/vacation-grid-01.png`

### VAC-02 — Vacation Settings (admin)
- **URL:** `/admin/vacationmanagement`
- **Purpose:** configure the rules governing the active vacation block.
- **Roles:** admin/scheduler only [INFERRED]
- **Fields [OBSERVED]:**
  - Short/Medium/Full Name-style identity fields are *not* here (those are on Group Settings) — this screen is scoped purely to vacation policy:
  - **Vacation Selection** (On/Off master switch)
  - **Vacation Block Start** / **Vacation Block End** (constrained: start must be a Monday, end must be a Friday — domain rule visibly enforced via helper text)
  - **Open Vacation Mode** — "Allow staff to make any vacation requests with no limits?" (Yes/No)
  - **Approval Required By Scheduler** (Yes/No) — toggles whether vacation requests need explicit approval (ties to VAC-01's Approve button)
  - **Include Weekend Before / Include Weekend After / Include Holidays** (each Yes/No) — controls whether adjacent weekend/holiday days count against the vacation allotment
  - **Allow Negative Avail / Allow Negative Grant** (each Yes/No) — whether staff can be over-drawn on vacation balance
  - **Weekly Vacation Quota** — a per-week editable target headcount table (mirrors the "Weekly Quota" row on VAC-01)
  - **Staff (N)** roster with per-staff **Vacation Grant** number, add/remove via chip tokens, plus **Add Staff / Add Locum / Add All / Clear** bulk tools — confirms a **"Locum"** staffing category distinct from regular staff, manageable at the group-membership level.
  - Cancel / Save
- **Related screens:** VAC-01, ADM-01 (Group Settings), ADM-05 (Staff/Users — "Locum" also appears there as an Access Level)
- **Open questions:** Relationship between "Locum" here (a vacation-roster membership concept) and "Locum" as a full Access Level in ADM-05 — same entity? [UNRESOLVED, likely yes]
- **screenshot_ref:** `screenshots/admin/vacation-settings-01.png`

### DA-01 — Daily Assignments
- **URL:** `/app/viewplm` (URL retains a `pickListId` — ties this screen directly to a specific picklist instance)
- **Purpose:** operational rundown of a single day's finalized work assignments plus the day's role-to-person mapping.
- **Roles:** all staff (reference screen) and admin (comments)
- **Sections:**
  - Date picker + Go
  - "Comments for `<date>`" collapsible banner (per-day free-text notes)
  - **Work for `<date>`** — numbered list, one row per assigned staff member, each showing that person's slot description (their assigned OR/site plus, where applicable, the supervising/primary physician referenced parenthetically) and a numeric badge per row. The badge is most plausibly a **count of cases/picks tied to that line** (consistent with case-list detail seen on SCH-01). [INFERRED]
  - **Assigned Positions for `<date>`** — a compact role→person directory for the day (On Call roles, Backup, CV/CICU call, Cardiac OR rooms, a "Part Time Group" bucket listing several names together, **Vacation** [lists who is off], **POST CALL**).
- **Related screens:** PLM-01 (Picklist Manager — same `pickListId`), SCH-01, SCH-05
- **Open questions:** Exact meaning of the numeric badge per work line; whether "Comments" supports @mentions/attachments. [UNRESOLVED]
- **screenshot_ref:** `screenshots/schedule/daily-assignments-01.png`

### PL-01 — Choose List (personal picklist/notification hub)
- **URL:** `/app/picklist`
- **Purpose:** per-site status of the signed-in user's active picklist participation, plus entry points to contact-channel and notification configuration.
- **Roles:** all staff
- **Sections:**
  - One block per site/group the user belongs to, each showing **"No active picklists"** or (implicitly) an active one to act on.
  - "Reminders will be sent to you by:" — enumerates the **channel stack**: Email, SMS text, Mobile voice call, Home voice call (with the account's own contact values shown — not reproduced here).
  - **Modify phone numbers** button → PL-03
  - **Modify Notifications** button → PL-02
- **Related screens:** PL-02, PL-03, PLM-01, DASH-01
- **Open questions:** What does an *active* picklist look like on this screen (presumably a live "it's your turn — pick now" call-to-action)? Not observed since none were active during this session. [UNRESOLVED]
- **screenshot_ref:** `screenshots/picklist/choose-list-01.png`

### PL-02 — Pick List Notification Settings
- **URL:** `/users/notifications`
- **Purpose:** per-user configuration of the escalating reminder/alert cadence used when it's their turn to pick, split by time-of-day policy.
- **Roles:** self-service (every user configures their own)
- **Fields [OBSERVED]:**
  - **Pick Proxy** — an On/Off toggle plus a "Select Proxy User" dropdown and **Save Proxy** — lets a user **delegate picklist notifications (and presumably picking authority) to another person** — e.g., for a delegate/assistant or covering colleague. This is the "proxy" concept referenced in the sidebar's disabled "Proxy Locked" column on ADM-05.
  - Two rule tables, one for **"Mandatory Hours"** (org-configured window, e.g. 8AM–5PM) and one for **"Personal Hours"** (a second, user-adjustable window, via **Personal Start Time / Personal Stop Time**), each with:
    - **Time** column = minutes-after-trigger offset (e.g., 0/30/60) — an **escalation ladder**
    - Per-channel **On/Off** toggles: **Email, SMS, Dial Mobile, Dial Home**
    - **Add Notification** (new escalation step) / **Delete** (remove a step) per row
  - **Load Defaults** / **Save Changes**
- **Data model implication:** notification policy = an ordered list of (offset-minutes × channel-set) escalation steps, scoped separately to "mandatory" vs. "personal" hours, with a configurable boundary time between the two. The exact same shape (Mandatory/Personal Hours, offsets, channel toggles) reappears as an **org-wide default** on ADM-01 (Group Settings) — strongly suggesting **user-level settings override group-level defaults**, with "Load Defaults" pulling the group template down to the user level. [INFERRED]
- **Related screens:** PL-01, ADM-01 (same schema, org-wide default), PL-03 (contact values that these channels actually use), ADM-05 ("Proxy Locked" / "Notification Locked" admin flags likely lock this screen's fields for a given user)
- **Open questions:** What "Proxy Locked" / "Notification Locked" (seen as columns in ADM-05) do to this screen when set to Yes. [UNRESOLVED]
- **screenshot_ref:** `screenshots/picklist/notification-settings-01.png`

### PL-03 — User Profile (Update Contact Info / Change Password)
- **URL:** `/users/profile`
- **Purpose:** self-service identity & credential management.
- **Fields [OBSERVED]:** User Account Email (read-only display), First name, Last name, Cell Phone, Home Phone, Pager, **"Calendar days to keep"** (a numeric retention setting — likely controls how many days of past schedule remain visible/subscribed via the iCal feed), **Update Contact Info** button. Separately: **Change Password** (Current/New/Re-type) with **Change password** button, plus a **default-group selector** (radio between the user's sites, e.g. "THP C Site" / "THP M/Q Site") and **Save Default Group** — controls which site loads by default at login, distinct from the always-available top-nav site switcher.
- **Related screens:** PL-01, PL-02, SYS-01
- **screenshot_ref:** `screenshots/picklist/user-profile-01.png`

### CON-01 — Contacts
- **URL:** `/app/contacts`
- **Purpose:** searchable/filterable staff directory with bulk-contact tooling.
- **Roles:** likely all staff (a phone-book), though bulk Send/Export may be admin-gated [UNRESOLVED]
- **Sections/controls:** quick filters **All / Staff / Locum / None** (confirms **Locum** as a first-class contact category alongside Staff), per-row checkbox selection, columns **Full Name & Email, Mobile, Home, Pager**, and bulk actions **Send Email, Send SMS, Export, Print** (none exercised — messaging/export actions are out of scope for read-only review).
- **Related screens:** ADM-05 (Staff/Users — same person records, admin-editable), PL-03 (a user's own contact fields feed this directory)
- **screenshot_ref:** `screenshots/navigation/contacts-01.png`

### DOC-01 — Documents
- **URL:** `/app/documents`
- **Purpose:** shared file repository organized by category, scoped to the current group.
- **Sections/controls:** category tree under the group name (categories observed include things like conference materials, COVID-era policy, departmental docs, education, financial/billing docs, holiday schedule, clinical-team resource lists, product-specific documentation, patient-communication templates, statistics) with a **File Name / File Size / Upload Date** table per category, plus admin tools **Add Category** and **UpLoad File** (not exercised).
- **Related screens:** none directly; standalone knowledge-base feature
- **Open questions:** Are categories/permissions scoped per-role (e.g., a "Financial"/"Ohip Billing" category hidden from plain staff)? [UNRESOLVED]
- **screenshot_ref:** `screenshots/admin/documents-01.png`

### PLM-01 — Picklist Manager (core admin workflow)
- **URL:** `/admin/picklists`
- **Purpose:** the operational control center for the "picklist" mechanism — running a fair, ordered, turn-based draft where staff pick their assignments for an upcoming day.
- **Roles:** admin/scheduler only [INFERRED]
- **Sections/controls:**
  - Top summary bar: sync/refresh indicator ("last synced N minutes ago") + manual refresh
  - Date-indexed table: **Date, Status** (`COMPLETED` / `ON HOLD` observed — implying a lifecycle with at least these two states, plus presumably an in-progress "active/started" state not seen live), **Picks** (x of y filled), **Ave** (average pick time in some unit), and per-row action buttons: **Start List** (begin the draft), **Import**, **Email** (notify participants), **Delete**, and a **Locked / Unlocked** toggle. Completed rows collapse to just a lock toggle + Email.
  - **Add Blank** (create a new blank picklist for a date)
  - Selected-date detail, three panels:
    - **Comments for `<date>`** — free text
    - **Staff for `<date>`** — a **numbered draft order** (1, 2, 3, …) of staff participating in that day's pick, with the note *"Changes to the pickorder must be made on the Master Schedule,"* confirming pick order is derived from/edited via the Master Schedule rather than here directly. Has its own **Import** tool.
    - **Work for `<date>`** — the list of assignable work items for the draft (shift/room slots), each with a drag handle (☰, implying manual reordering) and a numeric badge (again, likely a case/pick count), plus **Import / Add**.
- **Data model implication:** a "picklist" = {date, ordered staff queue, ordered/available work items, status, lock state}. The **turn-based draft metaphor** (numbered participant order + a pool of work items) is the literal mechanism behind the marketing phrase "unique picklist algorithm."
- **Related screens:** DASH-01 (live monitor for an active list), PL-01 (staff-facing "is it my turn" view), DA-01 (the finalized output of a completed picklist), SCH-02/03/04 ("Pick List Control" count)
- **Open questions:** What exact state(s) exist between "ON HOLD" and "COMPLETED" (an active "IN PROGRESS/LIVE" state almost certainly exists for when "Start List" has been clicked) — not observed since no list was mid-draft during this session. [UNRESOLVED]
- **screenshot_ref:** `screenshots/picklist/picklist-manager-01.png`

### DASH-01 — Dashboard (Active Pick Lists monitor)
- **URL:** `/admin/picklistmonitordashboard`
- **Purpose:** live operational monitor, presumably for a scheduler watching a draft happen in real time.
- **Sections:** live clock, an audio-alert mute/unmute toggle (speaker icon), and either "Currently, there are no active lists for you to monitor" or (inferred) a live feed of in-progress picklist activity when one is running.
- **Related screens:** PLM-01
- **Open questions:** Full content of the live/active state was not observed (none were active). [UNRESOLVED]
- **screenshot_ref:** `screenshots/admin/dashboard-01.png`

### ADM-01 — Group Settings
- **URL:** `/admin/groups`
- **Purpose:** top-level configuration for the current group/site — the org-wide defaults that individual settings (vacation, notifications) may inherit or override.
- **Fields [OBSERVED]:** Short Name, Medium Name, Full Name (three levels of the group's display name), **Report Box** (free text, purpose unclear — [UNRESOLVED]), **Request Until Date** (deadline for staff to submit requests against the schedule), **Schedule End Date** (how far the published schedule currently extends), **Pick List Start/End Time** (daily window during which picking happens), **Personal Start/End Time** (mirrors the Mandatory/Personal split seen in PL-02), **Locum Lockout Hours** / **Lockout Minimum Hours** (numeric — likely minimum rest/notice periods enforced by the scheduling engine), **Vacation shift** (dropdown selecting which shift-code represents "on vacation" for schedule-rendering purposes, e.g. the "OFF" code), **Final Picklist Emails** (a comma-separated distribution list notified when a picklist finalizes — org-level, not per-user), **Alert Pick Time** / **Alert Average Pick Time** (numeric thresholds, presumably driving the Dashboard's audio alert when a pick is taking too long), **ImportStrip** ("characters to be stripped" — data-cleanup rule applied on import, with an **Add Stripper** button implying a list of strip rules), **OR Daily Defaults** (a default Operating-Room count per day-of-week including Holidays, feeding the "Operating Rooms" figure seen on the Master Schedule), and a full duplicate of the PL-02 notification-escalation table pair (Mandatory/Personal Hours) at the **group** level.
- **Related screens:** PL-02 (per-user override of the same schema), SCH-02/03/04 (OR Daily Defaults feeds Staff Balance), PLM-01/DASH-01 (Alert Pick Time)
- **screenshot_ref:** `screenshots/admin/group-settings-01.png`

### ADM-02 — Builds
- **URL:** `/admin/builds`
- **Purpose:** version-controlled **schedule generation pipeline** — this is the most architecturally significant screen found. A "Build" is a named, dated schedule-generation run for a period (observed periods spanning ~166–182 days, i.e. roughly half-year/quarterly blocks), and multiple historical builds are retained per period (sequential IDs like `B783`, `B781`, `B778`, `B771` for the same date range — implying **iterative re-generation/versioning** before one is finalized).
- **Controls per build row (none exercised):** **Setup → Planner → Build → Fix Picks → Publish → Lock/Unlock**, i.e. an observable **six-stage pipeline**: (1) initial setup/parameters, (2) a planning stage, (3) the automated build/generation step, (4) a manual "fix picks" correction stage, (5) publish (push live, distinct icon suggesting it notifies/distributes), (6) lock (freeze from further edits) with unlock to reverse. A build that is already **Locked** shows only an "Unlock" control — confirming locking gates the rest of the pipeline.
- **Top-level tools (not exercised, high blast-radius):** **New Build**, **Erase Master Schedule** (a global destructive action — its label alone signals this is one of the most dangerous controls in the entire application), and per-row **Delete**.
- **Related screens:** SCH-02/03/04 (a build's output *is* the Master Schedule), PLM-01 (Builds likely precede/produce picklists)
- **Open questions:** What each of Setup/Planner/Build/Fix Picks does concretely; whether "Publish" is what makes a build visible on the Master Schedule (most likely yes). [UNRESOLVED — none clicked]
- **screenshot_ref:** `screenshots/admin/builds-01.png`

### ADM-03 — Staff Shift FTE
- **URL:** `/admin/staffshiftfte`
- **Purpose:** per-shift-type staff eligibility and quota configuration.
- **Sections:** a shift-type selector (dropdown + Prev/Next Shift), then a table: **Staff Name, Action (Edit), Active** (Yes/No — is this person eligible for this shift type at all), **Max Shifts**, and per-day-of-week quota columns **All, Mon…Sun, Hol** — i.e., a fine-grained **FTE-style cap matrix** (max times this person can work this shift type, broken out by weekday).
- **Related screens:** ADM-07 (Shifts catalog), ADM-02 (Builds likely consult this during generation)
- **screenshot_ref:** `screenshots/admin/staff-shift-fte-01.png`

### ADM-04 — Shift Statistics
- **URL:** `/admin/shiftstatistics`
- **Purpose:** date-range fairness/reporting tool.
- **Sections:** Start/End Date + Go, a shift-type selector (Prev/Next Shift), a **Shifts vs. Percentage** toggle with a numeric "credit weight" (e.g., 1.00) input, a **Show Variance** button, **Credits − (Target) − Actual Shifts** legend line, and Print/Share buttons (not exercised). Empty state: "No Picks" when no range selected.
- **Data model implication:** shifts can be weighted by a "credit" value (not necessarily 1 pick = 1 credit), and the tool compares **target vs. actual** — a fairness/audit report, echoing the marketing claim "Produce statistical reports to demonstrate that work is being divided fairly."
- **Related screens:** ADM-08 (Shift Groups' "Equation & Weight" concept likely feeds this same credit system)
- **screenshot_ref:** `screenshots/admin/shift-statistics-01.png`

### ADM-05 — Staff (Users) admin table
- **URL:** `/admin/users`
- **Purpose:** the org's master user/role administration screen.
- **Columns [OBSERVED, schema only — no personal values reproduced]:** Last Name, First Name, Email, **Access Level**, Cell Phone, Home Phone, **Action Time** (a numeric per-user setting, seen uniformly at one value in this tenant — meaning unclear, [UNRESOLVED], possibly a pick-turn time limit in seconds), **Picks Excluded** (a short list/range of numbers per user, e.g. "2,3,4" or "1-3" — likely which numbered pick-order rounds/positions this person is excluded from), **Admin Emails** (Yes/No), **Picklist Admin** (Yes/No), **Show In Grid** (Yes/No — whether they appear on the Master Schedule grid), **Proxy Locked** (Yes/No), **Notification Locked** (Yes/No), **Start Tour** (Yes/No — forces onboarding tour on next login). Inline **Edit ⇄ Update/Cancel** editing per row (confirmed interactively, then cancelled without saving), **Remove** per row, **Add User** top action.
- **Access Level values observed:** **Staff**, **Scheduler**, **Locum** — this is the concrete **role model** for the product (see §5).
- **Related screens:** CON-01 (same people, phone-book view), PL-02 (Proxy/Notification Locked likely gate that screen), VAC-02 ("Locum" roster overlaps this Access Level)
- **screenshot_ref:** `screenshots/admin/staff-users-01.png`

### ADM-06 — Staff Groups
- **URL:** `/admin/staffgroup`
- **Purpose:** named subsets of staff, for scoping eligibility/visibility elsewhere in the system.
- **Columns:** Id, Name (e.g., a general "OR-eligible" pool), Staffs (member list, shown as short codes), New/Edit/Delete.
- **screenshot_ref:** `screenshots/admin/staff-groups-01.png`

### ADM-07 — Shifts (shift-type catalog)
- **URL:** `/admin/shifts`
- **Purpose:** master catalog of every shift/role code used across On Call, Master Schedule, Picklist, and Daily Assignments.
- **Columns [OBSERVED]:** Full Name, Short Name (the code shown in grids), **Time Start / Time End**, **Call** (Yes/No — is this an on-call-type shift), **Manually** (Yes/No — assigned only by manual admin action, not via the picklist draft), **DailyPick** (Yes/No — offered in the picklist draft), **Stipend** (Yes/No — attracts extra compensation), and a per-row **Picks** "Edit" (a further eligibility/rule sub-screen not opened), plus **Delete** and **New**.
- **Data model implication:** every shift type is independently flagged along three orthogonal axes — call vs. non-call, manual-only vs. pickable, and stipend vs. not — which together determine how a given shift type surfaces (or doesn't) throughout the rest of the product.
- **Related screens:** ADM-03, ADM-08, ADM-09, SCH-02/03/04
- **screenshot_ref:** `screenshots/admin/shifts-01.png`

### ADM-08 — Shift Groups
- **URL:** `/admin/shiftgroup`
- **Purpose:** named bundles of individual shift codes, used for two purposes observed directly: (a) **fairness scoring** and (b) **"request off" targeting**.
- **Columns:** Id, Name (e.g., a group representing "all on-call shift types," another for "all cardiac OR rooms," another combining two specific call types), **Shifts** (the member shift codes), **Equation & Weight** — values observed: **"Hard (0)"** and **"Linear (1000)"**, i.e., a scoring/constraint model with at least two modes (a hard constraint vs. a linear-weighted one), **Allow Request** (Yes/No — whether staff can submit a "request off" against this whole bundle rather than one shift at a time), and **Request Off Text** (the exact phrasing shown to staff when requesting off this group, e.g. "Request off All Calls."). This directly explains a request tooltip observed on the Master Schedule (encoded as requester + status + `{{group name}}`) — **staff requests are frequently made against a Shift Group, not a single shift code.**
- **Related screens:** SCH-02/03/04 (request tooltips), ADM-04 (credit weighting)
- **screenshot_ref:** `screenshots/admin/shift-groups-01.png`

### ADM-09 — Valid Groups
- **URL:** `/admin/validgroups`
- **Purpose:** [UNRESOLVED] — a short named list (2 entries observed, e.g. "Call with picks," "QCall with Picks") with Edit/Delete/New but no further schema visible without opening Edit (not done, to stay strictly read-only about rule *content* while still confirming the screen's existence). Most likely defines which shift/pick combinations are considered a legal pairing for the scheduling engine's validation pass. [INFERRED]
- **screenshot_ref:** `screenshots/admin/valid-groups-01.png`

### ADM-10 — Pattern Rules
- **URL:** `/admin/patterns`
- **Purpose:** the **fairness/spacing rule engine** — this is the concrete mechanism behind the marketing claim "optimal call spacing algorithm."
- **Columns:** ID, Pattern Name, **Pattern** (a small domain-specific-language expression, structurally: `Activation(<trigger shift/shift-group>) - <same or related shift>(Optimal Spacing)`, sometimes with explicit day-offsets in parentheses, e.g. `(-7)`, `(7)`, `(-1)`, `(8)`, and sometimes chaining multiple alternatives with `/`), **Days** (scope: `ALL+HOLIDAYS`, or a specific weekday like `TH`/`SA`/`SU`, or a combination like `SA/SU/H`).
- **11 rules observed total**, covering things like: avoiding back-to-back specific call types, enforcing minimum spacing between repeats of the same shift (with explicit day offsets, i.e. "not again for at least N days"), weekend-specific spacing rules, and a catch-all "ALL CALLS Optimal Space" rule operating on the broad on-call Shift Group.
- **Data model implication:** the scheduling engine supports **activation-triggered, day-offset-based spacing constraints**, scoped by weekday, defined declaratively rather than hard-coded — this is the single richest piece of evidence about the underlying constraint-solving approach used to generate "Builds."
- **Related screens:** ADM-02 (Builds — patterns almost certainly run during the "Build"/"Fix Picks" stages), ADM-08 (Shift Groups referenced by name inside pattern expressions, e.g. `{All Call}`)
- **screenshot_ref:** `screenshots/admin/pattern-rules-01.png`

### SYS-01 — Site/Group switcher
See NAV-01. Two entries observed for this tenant ("THP C Site", "THP M/Q Site"). Not switched (to avoid losing session context mid-review); default group is separately configurable on PL-03. **screenshot_ref:** `screenshots/navigation/site-switcher-01.png`

### SYS-02 — User account menu
See NAV-01. Items: **My Profile** (→ PL-03), **Notification Settings** (→ PL-02), **Sign In As** (impersonation — not exercised), **Sign Out**. **screenshot_ref:** `screenshots/navigation/user-menu-01.png`

### SYS-03 — Support
External link to a Zendesk help center (`ischedulemd.zendesk.com`); not explored further as it is a third-party support/ticketing product, not part of ischedule.MD's own application surface.

### SYS-04 — Tour
Label/control observed in the top bar on every page; did not visibly trigger an overlay on the pages tested. [UNRESOLVED] whether it's context-sensitive, first-login-gated, or requires a specific screen.

---

## 4. Master checklist (requested topics)

| Topic | Status | Notes |
|---|---|---|
| **Roles** | Partially mapped | Confirmed Access Levels: **Staff, Scheduler, Locum** (ADM-05). Admin/Scheduler-level screens (Picklist Manager, all of Scheduling admin, Vacation approve/transfer, Dashboard, Sign In As) were all visible to the account used, which itself is provisioned as at least Scheduler-equivalent. Exact per-role screen/field visibility matrix is [UNRESOLVED] — would require comparing sessions across roles. |
| **Users/groups** | Mapped | Multi-site tenancy via `groupId`; one account can belong to 2+ groups with a default-group preference (PL-03) and a live switcher (SYS-01). Users have Access Level, contact channels, and several lock/permission flags (ADM-05). |
| **Master scheduling** | Mapped | Three view modes (Date/Staff/Shift), batch tooling, Print exports, tied to the Builds pipeline (ADM-02). |
| **Scheduling configuration** | Mapped | Group Settings (ADM-01), Staff Shift FTE (ADM-03), Shifts catalog (ADM-07), Shift Groups (ADM-08), Valid Groups (ADM-09, partially), Pattern Rules (ADM-10). |
| **Requests** | Partially mapped | Surfaced via: My Schedule's "My Requests" panel + PENDING filter; Master Schedule's per-day Requests count + hover tooltip (requester + change + target Shift Group + status icon); Shift Groups' "Allow Request"/"Request Off Text". The request *submission* form itself was not located/opened — [UNRESOLVED] where staff actually file a new request from. |
| **Vacation** | Mapped | Full lifecycle screens: staff/admin grid (VAC-01), settings (VAC-02), Approve/Transfer/Batch tooling (not exercised), quota vs. requested tracking, Locum-inclusive rostering. |
| **Opportunities/swaps** | Partially mapped | "Opportunity Board" (SCH-01) lists claimable future pick positions; "Swap Shift" button exists on My Schedule. Neither's underlying flow was opened (would require an interactive click into a live opportunity/swap, none were exercised to stay read-only about actual submission). |
| **Daily assignments** | Mapped | DA-01, tightly coupled to a specific `pickListId`. |
| **Picklists** | Mapped in depth | This is the product's signature mechanism: Picklist Manager (PLM-01), live Dashboard monitor (DASH-01), personal Choose List (PL-01), the pick-order concept threaded through Master Schedule and Builds. |
| **Notifications/proxies** | Mapped in depth | Two-tier (group default / per-user override) escalation-ladder model with Mandatory vs. Personal hour windows, 4 channels (Email/SMS/Dial Mobile/Dial Home), plus a "Pick Proxy" delegate-user mechanism (PL-02), and admin-side lock flags (ADM-05). |
| **Reports** | Partially mapped | Print exports (Schedule/Picklist/Stipend/Requests on Master Schedule), Shift Statistics (ADM-04) fairness report. Not exercised (would trigger downloads). |
| **Contacts** | Mapped | CON-01. |
| **Documents** | Mapped | DOC-01, category-tree file repository. |
| **Integrations** | Sparse | iCal-style schedule subscription implied by "Subscribe" button + "Calendar days to keep" setting; click-to-call phone chips on On Call; no other external integrations (SSO, EHR, paging-system API, etc.) were surfaced anywhere in the explored UI. [UNRESOLVED] whether any exist server-side/invisible to the UI. |
| **Data model** | Mapped at a conceptual level | See §6 (entity list) below. |
| **APIs** | Not observed | No API docs, tokens, or developer surface found in-app; out of scope to search for beyond the UI per instructions anyway. |
| **Edge cases** | One notable case found | Vacation-grid badge click defaults straight into a destructive confirmation dialog rather than a neutral detail view (§ VAC-01, and see Safety notes). Empty states observed for: On Call (n/a — always populated), Choose List ("No active picklists"), Dashboard ("no active lists to monitor"), Shift Statistics ("No Picks" pre-date-selection), Documents (category with presumably-empty file list, not fully confirmed). |
| **Mobile** | Inconclusive | Product markets itself around a "mobile picklist" (phone-based pick notifications: SMS/voice/dial), which is a **phone-channel** mobile story rather than necessarily a responsive web layout. A window-resize test to a phone viewport did not visibly reflow the Master Schedule/My Schedule layout in this session — [UNRESOLVED], test was inconclusive (viewport rendering did not clearly change), needs a follow-up pass with a proper mobile emulation profile. |
| **Accessibility** | Not assessed | No screen-reader/contrast/keyboard-nav testing performed this pass; out of scope for a pure navigation map. Flagged for a future accessibility-focused pass. |
| **Security-sensitive behaviour** | Noted | (1) "Sign In As" impersonation control exists in the user menu — high sensitivity, not exercised. (2) The account used has simultaneous access to admin configuration (Builds, Erase Master Schedule, Pattern Rules, full user roster with contact PII) and personal staff screens — suggests coarse-grained rather than screen-by-screen permission checks, though this is [INFERRED] from one session, not confirmed by testing a lesser role. (3) Contact PII (names, personal emails, personal phone numbers) is broadly visible across Contacts, On Call, Master Schedule (Staff View), and the Users admin table to whatever role this account represents — a real product would need a clear data-minimization/role-based-redaction story here. (4) Vacation badge click → destructive-action-by-default (see Edge cases). |

---

## 5. Role model (as inferred from ADM-05 + screen access)

> **Superseded by Phase 3** ([02-role-permission-matrix.md](02-role-permission-matrix.md) §5–§8): a full paginated read of both groups' user rosters found **six** Access Level values (Staff, Locum, View, Telecom, Scheduler, Genius), not three, and established that role is scoped **per group membership** rather than being a single global account attribute. The table below is kept for historical record but should not be treated as current.

| Access Level | Evidence | Inferred scope |
|---|---|---|
| **Staff** | Listed value in ADM-05 Access Level column | Baseline clinician role; presumably sees My Schedule, On Call, Vacation (own), Daily Assignments, Choose List, Contacts, Documents — but likely **not** Picklist Manager or the Scheduling admin accordion. [UNRESOLVED — not verified with a Staff-level session] |
| **Scheduler** | Listed value; one example row also had **Admin Emails: Yes** and **Picklist Admin: Yes** flags set | Operational admin: runs picklists, approves vacation, configures schedule. Matches the elevated access of the session used for this review. |
| **Locum** | Listed value; also a distinct filter on Contacts and a distinct roster concept on Vacation Settings | Temporary/relief staff — appears to be handled as a first-class but functionally-limited category (e.g., different lockout-hours rule "Locum Lockout Hours" on ADM-01, different default flags like Show-In-Grid=No for some Locum rows observed in ADM-05's schema though specific values are not reproduced here). |
| *(possible additional "Admin" tier)* | Not directly observed as a distinct Access Level value, but **Admin Emails** and **Picklist Admin** are separate Yes/No flags layered on top of Access Level | Suggests permissions are **role + flags**, not a single flat role enum — i.e., a Scheduler can additionally be granted Admin Emails and/or Picklist Admin independently. [INFERRED] |

---

## 6. Core domain concepts / glossary (as used by the product, generic — no site-specific codes reproduced beyond structural examples already covered above)

- **Group** — a tenant/site scope; a user can belong to multiple groups with a default and a live switcher.
- **Build** — a versioned, staged (Setup→Planner→Build→Fix Picks→Publish→Lock) generation run of the Master Schedule for a date range.
- **Master Schedule** — the published staff×date×shift-slot grid, viewable three ways (Date/Staff/Shift).
- **Shift** — a catalog entry (ADM-07) with a code, time window, and three independent flags: on-call, manual-only, and stipend-eligible; plus whether it's offered via daily picking.
- **Shift Group** — a named bundle of shift codes used for (a) fairness weighting ("Equation & Weight": Hard vs. Linear) and (b) grouped "request off" targeting.
- **Pattern Rule** — a declarative spacing/fairness constraint of the form "activation of shift X implies a spacing constraint on shift Y, with optional explicit day offsets," scoped to specific weekdays or all days+holidays.
- **Picklist** — a single day's turn-based draft: an ordered staff queue + a pool of work items; lifecycle states include at least On Hold and Completed (an active/in-progress state is presumed but unobserved).
- **Pick order** — the numbered sequence in which staff take turns in a picklist; edited via the Master Schedule, displayed in Picklist Manager.
- **Opportunity Board** — a list of future, specific "pick" slots becoming available (e.g., because of a cancellation or a newly-added position) that any eligible staff member can claim.
- **Vacation Block** — a configurable global date range within which vacation requests, quotas, and approvals are tracked; has its own quota-vs-request accounting per week, separate from the Pattern-Rule/Build machinery.
- **Locum** — a relief/temporary staffing category, functionally distinct in vacation rostering, contacts filtering, and lockout-hours configuration.
- **Notification escalation** — a per-user (overriding a per-group default) ladder of {time offset, channel set} steps split across "Mandatory Hours" and "Personal Hours," with 4 channels: Email, SMS, Dial Mobile, Dial Home; supports proxy delegation to another user.
- **Staff Balance** — a live, per-day computed figure = Staff Available − Daily Picks − Operating Rooms, surfaced prominently on the Master Schedule as a staffing-adequacy signal.

---

## 7. Safety & boundary notes (what was deliberately *not* done, and why)

- No form was submitted; no Save/Update/Approve/Publish/Delete/Remove/Lock/Unlock/Start List/Batch Add/Batch Delete/New Build/Erase Master Schedule/Add Staff/Add Locum/Add All/Clear/Send Email/Send SMS/Export/Sign In As action was invoked.
- **One near-miss:** on the Vacation grid (VAC-01), clicking a colored status badge (which looked like it might open a read-only detail popover, consistent with a similar tooltip pattern seen elsewhere in the app) instead opened a modal that defaults directly to a **delete-vacation-week confirmation** ("Do you wish to delete the week of vacation … ?") with Remove/Deny buttons alongside Cancel. The modal was dismissed via **Cancel**, and no other vacation-grid badges were clicked again afterward to avoid repeating the risk. This is recorded above as a UX/edge-case finding, and is a concrete lesson for SchedulePoint: **do not make deletion/denial the default landing state of an inspection click.**
- Two admin "Edit" inline-forms (Users table row, and the Staff Balance modal's Operating Rooms field) were opened to observe field structure, then explicitly closed via **Cancel**/**Close** without submitting.
- Several categories of real personal data were visible during this review (staff full names, personal emails, personal phone numbers, and — on one screen — clinical case-level detail including patient ages and procedure descriptions). **None of that data is reproduced anywhere in this report**; only field names, screen structure, and behavior are described.
- Print/Export/Share buttons were located but not clicked, to avoid triggering uncontrolled file downloads.
- The site switcher was not used to change the active group, to avoid altering session/default state mid-review.

---

## 8. Evidence & follow-up needed (tracked in companion files)

- Actual screenshot files were **not** exported to `schedulepoint-research/screenshots/` during this pass; `screenshot_ref` values above are the intended target paths for a follow-up capture pass. See [manifest.json](manifest.json) for the folder convention.
- Open items above marked **[UNRESOLVED]** should be copied into [unresolved-questions.md](unresolved-questions.md) for tracking.
- Every screen/URL pair above should be logged into [source-page-index.md](source-page-index.md); this report can serve as the seed data for that index.
- This report itself, once filed, should get an entry in [evidence-register.md](evidence-register.md) noting it as a text-evidence artifact (not a screenshot).
