# Final Coverage Audit: ischedule.MD

**Purpose:** the final, bounded coverage-reconciliation pass before SchedulePoint product consolidation begins. This is **not** a new deep investigation — it checks whether any safely accessible part of ischedule.MD is missing from the completed twelve-phase research effort, and folds in any genuinely new, passively-observed findings.

**Method:** read-only navigation via Claude for Chrome, using only links, tabs, menus, view selectors, and passive DOM/JS inspection (`href`, hidden-dialog markup, computed style) — the exact technique that resolved several unresolved questions in Phases 10 and 11 without ever clicking an unsafe control. No form was submitted, no Add/New/Create/Import/Save/Send/Publish/Approve/Delete/Lock/Unlock/Sign-in-as control was clicked. See §12 for the one deliberate exception to "ordinary navigation": a live picklist was discovered incidentally, and per this audit's explicit brief it was **not** pursued.

**Evidence labels:** **[OBSERVED]** · **[INFERRED]** · **[UNRESOLVED]**, consistent with all prior reports.

---

## 1. Executive conclusion

**COVERAGE AUDIT PASSED WITH NON-BLOCKING GAPS — proceed to Phase 13**

Across a systematic reconciliation of the global navigation, every previously-documented screen, both authorized group memberships, and passive hidden-dialog inspection of every screen visited, **no entirely new top-level screen or navigation area was found**. The application's navigable surface, to the depth reachable by this Scheduler-level account without a mutating click, matches the eleven-phase inventory almost exactly.

What this pass *did* find, entirely through passive, already-established-safe navigation:

- **Seven genuinely new, previously-uncatalogued surfaces** (a Calendar Event creation dialog, an On Call contact dialog and its own report dialog, a Shift Statistics "Share" dialog, Contacts' full Send Email/Send SMS field schema, a second real Help destination, and a header notification-banner template) — all resolved via the same zero-click, hidden-DOM-inspection technique that produced Phase 10's Print-menu bonus finding. None required activating a prohibited control.
- **One significant state change**: a live, in-progress picklist was discovered to exist in the account's other group membership at the moment of this audit. Per this audit's explicit instruction, it was **not** pursued — no Dashboard, no Picklist Manager row, no room-selection UI was opened. This is recorded as a fact (the state exists and looks like an aggregate "pick N of M" progress bar) and the underlying execution mechanics remain carried forward exactly as before.
- **Cross-group corroboration** of one existing open question (the Contacts-vs-Users roster-count discrepancy, previously observed in one group, now confirmed present in both).
- **Zero** newly-discovered admin screens, zero newly-discovered top-level nav items, zero role-visibility changes, zero broken/orphaned pages.

Nothing found in this pass contradicts prior findings; nothing found requires reopening a phase or re-deriving a conclusion already reached. The "non-blocking gaps" in the verdict above refer entirely to **pre-existing, already-carried-forward gaps** (live picklist execution mechanics chief among them) that this audit's own brief explicitly instructs not to close. Product consolidation may begin.

---

## 2. Scope and safety constraints

This audit operated under [RESEARCH-RULES.md](../RESEARCH-RULES.md) plus additional constraints specific to this pass:

- Read-only navigation only: links, tabs, menus, group switcher, already-established-safe modals inspected for structure only.
- No control was clicked whose effect was not already definitively established as read-only, or whose label suggested any mutating verb.
- No file was uploaded, downloaded, imported, exported, or opened.
- No form was submitted; hidden dialogs were inspected via passive DOM reads (element IDs, labels, input types) exactly as Phase 10 did for the Print-menu report dialogs — never opened via click.
- **Explicit additional constraint honored:** upon discovering that a picklist was actively in progress in one of the account's two group memberships, no further investigation of picklist execution, real-time behavior, or room selection was undertaken, per this audit's brief ("Do not pursue any previously deferred gap that requires: an active picklist... Carry those forward rather than attempting to close them"). See §12.
- Real personal data encountered during this pass (the reviewing account's own name, email, and phone number, visible on the Choose List and Notification Settings screens as in every prior phase) is **not reproduced anywhere in this report**, consistent with every prior report's handling of the same recurring fields.

---

## 3. Groups or membership contexts reviewed

Both of the account's existing group memberships were reviewed, exactly as in Phase 3's original GRP-01 finding — no new group membership was discovered and none was expected:

- **THP M/Q Site** (`groupId=8`) — the default/home group for this session; the full sweep in §5–§7 was performed here.
- **THP C Site** (`groupId=7`) — switched into briefly via the ordinary top-nav site switcher (the same mechanism Phase 3 used) to confirm sidebar/route parity and to spot-check Documents and Contacts. **Picklist Manager, Dashboard, and Choose List were deliberately not opened while this group was active**, because this is the group with a picklist actively in progress at the time of this audit (see §12). The session was switched back to THP M/Q Site before concluding.

---

## 4. Expected coverage inventory

Compiled from all eleven prior reports and the four companion index files before any new navigation was performed:

**Navigation chrome:** NAV-01 (top bar: logo, Tour, Dashboard, site switcher, user menu), NAV-02 (11-item sidebar + accordion).

**Documented screens (34 stable IDs, source-page-index.md rows 1–78 collapse to):** SCH-01 (My Schedule), SCH-02/03/04 (Master Schedule, 3 views), SCH-05 (On Call), VAC-01/02 (Vacation grid + Settings), DA-01 (Daily Assignments), PL-01/02/03 (Choose List, Notification Settings, Profile), CON-01 (Contacts), DOC-01 (Documents), PLM-01 (Picklist Manager), DASH-01 (Dashboard), ADM-01..ADM-11 (Group Settings through Staff Rules), SYS-01..SYS-05 (site switcher, user menu, Support, Tour, Sign In As), plus 23 user-facing workflows (WF-01..23), 5 request/vacation/opportunity/swap lifecycles (LC-01..05), the picklist system's 6 sub-areas (§0–§6 of report 07), 9 supporting-module findings (SM-01..09), 19 responsive/accessibility findings (RA-01..19) with 8 SchedulePoint recommendations (F-01..08), and 14 technical/API findings (API-01..14, T-01..10).

**Administrative and ordinary-user surfaces:** fully mapped — 11 admin screens under the Scheduling accordion, all reachable only from the Scheduler-level account used throughout; ordinary-user surfaces (My Schedule, On Call, Vacation, Daily Assignments, Choose List, Contacts, Documents) reachable by the same account.

**Group-dependent surfaces:** confirmed to re-scope by `groupId` — rosters, request windows, vacation blocks, picklists all independently scoped per group (GRP-01).

**Mobile/responsive surfaces:** fully audited in Phase 10 (desktop/tablet/phone breakpoints, RA-01 through RA-19) — not a navigation-completeness gap, out of scope to re-test visually in a coverage reconciliation.

**External integrations and supporting modules:** Support (Zendesk, external), the `webcal://` calendar-subscription feed, Gravatar (third-party avatar), no SSO/EHR/paging integration found anywhere.

**Known inaccessible or deliberately untested surfaces (carried in from prior phases):** any Staff/Locum/View/Telecom/Genius-role session (no second account available); live picklist execution UI (no active list, until this audit); the two unopened PDF documents; every mutating action's actual server-side effect (Save/Publish/Approve/Delete/etc.).

This inventory is the baseline against which §5–§9 below are reconciled.

---

## 5. Navigation-to-report reconciliation table

| Nav surface | Expected (from inventory) | Reconciliation result | Report / Evidence ID |
|---|---|---|---|
| Top bar (logo, Tour, Dashboard, site switcher, user menu) | NAV-01 | **COVERED** — identical to Phase 1/3 record; one addition, see §6 (header banner template) | 01-application-map NAV-01 |
| Sidebar (11 items + 11-item Scheduling accordion) | NAV-02 | **COVERED** — a full `<a href>` sweep on both groups returned the identical 22-route set (`/admin/*` ×11, `/app/*` ×6, `/vacation/index`, `/users/*` ×2, plus Support) with no new or missing item | 01/02-application-map NAV-02, ADM-11 |
| My Schedule (`/app`) | SCH-01 | **COVERED** — landing page, Opportunity Board, My Requests panel structurally unchanged | 01-application-map SCH-01 |
| Master Schedule (`/app/schedulenew`, 3 views) | SCH-02/03/04 | **COVERED**, plus **NEW**: a hidden Calendar Event creation dialog — see §6 | 04-master-schedule; §6 CAL-01 |
| On Call (`/app/oncalltoday`) | SCH-05 | **COVERED**, plus **NEW**: Email/SMS contact dialog and a dedicated "Create On Call Schedule Report" dialog — see §6 | 01-application-map SCH-05; §6 SM-10/SM-11 |
| Vacation (`/vacation/index`) + Settings | VAC-01/02 | **COVERED** — badge modal, TRANSFER, Batch Entry Off/Approve all present and unchanged; one minor label addition ("REQUEST" as an alternate confirm-button label in the same shared modal) | 06-requests-vacation-opportunities LC-01/LC-01b |
| Daily Assignments (`/app/viewplm`) | DA-01 | **COVERED** — Date/Go only, no drift | 01-application-map DA-01 |
| Choose List (`/app/picklist`) | PL-01 | **COVERED**, plus a genuinely new **state** observed (live picklist progress) — see §6, §12 | 01-application-map PL-01; §6/§12 PL-04 |
| Notification Settings (`/users/notifications`) | PL-02 | **COVERED** — identical field set; confirmed the per-step edit dialog is shared with Group Settings' own copy | 01-application-map PL-02 |
| Profile (`/users/profile`) | PL-03 | **COVERED** — identical field set | 01-application-map PL-03 |
| Contacts (`/app/contacts`) | CON-01 | **COVERED**, plus **NEW**: full Send Email/Send SMS field schema resolved passively — see §6 | 01-application-map CON-01; §6 SM-13 |
| Documents (`/app/documents`) | DOC-01 | **COVERED** — identical controls in both groups (34 category links seen on group 8; parity confirmed on group 7) | 01-application-map DOC-01 |
| Picklist Manager (`/admin/picklists`) | PLM-01 | **COVERED** for group 8 (empty state, unchanged); group 7's currently-active list deliberately not opened — see §12 | 07-picklist-system PLM-01 |
| Dashboard (`/admin/picklistmonitordashboard`) | DASH-01 | **COVERED** by reference only this pass — deliberately not revisited while a picklist is live in the other group, to avoid observing live monitor content; no navigation-structure risk since the screen itself was already fully documented in Phase 1/8 | 01-application-map DASH-01; see §12 |
| Group Settings (`/admin/groups`) | ADM-01 | **COVERED** — identical field set; the notification-step edit dialogs are the same shared component seen on PL-02 | 01-application-map ADM-01 |
| Builds (`/admin/builds`) | ADM-02 | **COVERED**, plus **NEW**: a second, distinctly-named Help link — see §6 | 05-scheduling-engine ADM-02; §6 SM-14 |
| Staff Shift FTE (`/admin/staffshiftfte`) | ADM-03 | **COVERED**, plus confirms a Help link here too (same stub as Vacation's) — see §6 | 01-application-map ADM-03; §6 SM-14 |
| Shift Statistics (`/admin/shiftstatistics`) | ADM-04 | **COVERED**, plus **NEW**: the "Share" button's dialog fully resolved — see §6 | 01-application-map ADM-04; §6 SM-12 |
| Staff/Users (`/admin/users`) | ADM-05 | **COVERED** — Kendo grid, inline edit unchanged | 02-role-permission-matrix ADM-05 |
| Staff Groups (`/admin/staffgroup`) | ADM-06 | **COVERED** — no drift | 01-application-map ADM-06 |
| Shifts (`/admin/shifts`) + Pick Shifts | ADM-07 | **COVERED** — Pick Shifts modal unchanged | 05-scheduling-engine ADM-07 |
| Shift Groups (`/admin/shiftgroup`) | ADM-08 | **COVERED** — no drift | 01-application-map ADM-08 |
| Valid Groups (`/admin/validgroups`) | ADM-09 | **COVERED** — no drift | 05-scheduling-engine ADM-09 |
| Pattern Rules (`/admin/patterns`) | ADM-10 | **COVERED** — no drift | 05-scheduling-engine ADM-10 |
| Staff Rules (`/admin/staffrules`) | ADM-11 | **COVERED** — no drift | 02-role-permission-matrix ADM-11 |
| Sign In As (`/admin/signas`) | SYS-05 | **COVERED** by reference — not re-opened this pass (no new information would be gained from re-loading a static, already-fully-documented form) | 02-role-permission-matrix SYS-05 |
| Support (external Zendesk) | SYS-03 | **COVERED** — link destination unchanged | 01-application-map SYS-03 |
| Tour | SYS-04 | **COVERED** — confirmed still `href="javascript:void(0)"`, `id="tourStart"`; not re-clicked (already failed to fire on 2+ prior attempts, consistent with "do not click merely to discover") | 08-supporting-modules SM-07 |
| Group switching | GRP-01 | **COVERED, reconfirmed** — identical 22-route sidebar/admin set on both groups via direct href sweep (stronger evidence than Phase 3's manual click-through) | 02-role-permission-matrix GRP-01 |

---

## 6. Newly discovered surfaces

All seven items below were found entirely through passive DOM inspection of already-loaded, already-safe pages — reading hidden dialog markup (IDs, `<label>` text, `<input>` types) exactly as Phase 10 did to resolve the Master Schedule Print-menu mystery. **None was opened via click; none was submitted.**

### CAL-01 — Calendar Event creation dialog (Master Schedule)
- **Trigger [OBSERVED, not clicked]:** an **"ADD EVENT"** button (`id="saveCalendarEvent"`) sits inside a hidden dialog (`id="dialogCalendar"`) on Master Schedule, plausibly opened by clicking the "Calendar events" header row noted as unresolved in Phase 5 (unresolved-questions.md #39).
- **Fields [OBSERVED via hidden-DOM read]:** Title (text), Location (text), All-day (checkbox), Starts (text/datetime), Ends (text/datetime).
- **Significance:** this is a generic, non-clinical calendar-appointment creation form — distinct from shift/schedule data — **partially resolving** unresolved-questions.md #39 ("What does the 'Calendar events' row show when populated?"). The row itself remaining unpopulated in every date range browsed across 12 phases is unchanged; only the *creation surface's shape* is now known.
- **Classification:** **NEW**. **Evidence:** hidden-DOM read of `#dialogCalendar` on `/app/schedulenew`.

### SM-10 — On Call contact dialog (Email/SMS)
- **[OBSERVED]** On Call (`/app/oncalltoday`) has **Email** and **SMS** buttons (previously only "click-to-call phone chips" were documented, and Phase 4's WF-07 confirmed those chips are *not* `tel:` links). A hidden dialog `dialogSendSMS` exists with `Email`/`SMS`/`Close` actions, consistent with a per-contact "how would you like to reach this person" chooser rather than a direct dial action.
- **Classification:** **NEW** — refines WF-07's finding rather than contradicting it (phone chips still aren't `tel:` links; they now appear to open a channel-choice dialog instead).
- **Evidence:** hidden-DOM read on `/app/oncalltoday`.

### SM-11 — "Create On Call Schedule Report" dialog
- **[OBSERVED]** On Call's own **Print** buttons open a dialog titled **"Create On Call Schedule Report"** (Print/Cancel) — the same "Create `<Type>` Report" pattern family Phase 10 discovered on Master Schedule (Schedule/Picklist/Stipend/Requests/DayXShift), now confirmed to extend to On Call as a **sixth** report type.
- **Significance:** **partially resolves** unresolved-questions.md #58 ("What do On Call's... Print/Share buttons actually do?") — confirms a configuration-dialog step precedes output here too, not an instant download.
- **Classification:** **NEW**. **Evidence:** hidden-DOM read of `#dialogOnCallReport`.

### SM-12 — "Sharing Statistics Report" dialog (Shift Statistics)
- **[OBSERVED]** Shift Statistics' **Share** button opens `printStatModal`, titled **"Sharing Statistics Report"**, with a staff multi-select (`staffsSelect`), a second filter multi-select (`staffsFilterSelect`), and a message textarea — an internal, recipient-targeted sharing mechanism, not a generic copyable link or external share.
- **Significance:** **resolves** the Shift Statistics portion of unresolved-questions.md #58.
- **Classification:** **NEW**. **Evidence:** hidden-DOM read of `#printStatModal` on `/admin/shiftstatistics`.

### SM-13 — Contacts Send Email / Send SMS composition fields
- **[OBSERVED]** `dialogSendEmail`: To (recipient list, populated from row selection), Cc (text field, backed by a hidden `hiddenCcAddress`), Subject (text), an unlabeled `<select>` (purpose unresolved — possibly a template/signature selector), Body (textarea), Send/Cancel. `dialogSendSMS` (same modal id as SM-10, reused on Contacts): a single `message` textarea, Send/Cancel. No attachment field was found on either.
- **Significance:** **fully resolves** unresolved-questions.md #62 ("What are the composition fields, templates, attachment options, and validation for Contacts' Send Email/Send SMS bulk actions?") for the field-schema portion; the unlabeled `<select>`'s purpose remains **[UNRESOLVED]** and is carried forward.
- **Classification:** **NEW**. **Evidence:** hidden-DOM read of `#dialogSendEmail`/`#dialogSendSMS` on `/app/contacts`.

### SM-14 — A second, distinctly-named Help destination
- **[OBSERVED, via `href` only, not opened]** Builds (`/admin/builds`) has its own **Help** link, pointing to **`/Help/build.schedule.pdf`** (`target="_blank"`) — a real, purpose-named filename, unlike Vacation's placeholder `/Help/ComingSoon.pdf`. Staff Shift FTE (`/admin/staffshiftfte`) also has a Help link, but it points to the same `/Help/ComingSoon.pdf` stub as Vacation.
- **Significance:** **resolves** unresolved-questions.md #61 ("Do other Help buttons exist elsewhere, and if so do they point to the same stub or different content?"). Answer: Help is a **product-wide pattern**, not Vacation-specific as Phase 9 could only speculate — and destinations vary: at least one screen (Builds) has real, distinctly-named content while at least two (Vacation, Staff Shift FTE) share the same unimplemented stub. Neither file was opened.
- **Classification:** **NEW**. **Evidence:** `href` inspection on `/admin/builds` and `/admin/staffshiftfte`.

### NAV-03 — Header notification-banner template
- **[OBSERVED, via DOM/CSS inspection only]** A link (`href="/app/picklist"`, text "Please click here to view your pick lists.") exists as the literal first child of `<header>` on every page, ahead of the entire nav content. Its computed style is `display:inline; visibility:visible` yet its layout bounding box is genuinely zero-sized — consistent with a client-side notification template (in the same family as the `bootstrap-notify`-driven "Room Created." toast from Phase 8 §0) that is populated/shown by script only when the viewing account has an active picklist, and otherwise collapses to nothing.
- **Significance:** a previously-undocumented, product-wide "you have an active picklist" banner mechanism, distinct from and in addition to the Dashboard/Choose List indicators already known.
- **Classification:** **NEW**. **Evidence:** computed-style and bounding-rect inspection on `/app`, `/app/schedulenew`, `/vacation/index`.

---

## 7. Partially covered surfaces

| Surface | Gap closed this pass | Still open |
|---|---|---|
| Vacation Block Selection modal (WF-08/WF-09/LC-01) | Confirmed a **"REQUEST"** button-label variant coexists with "Confirm" in the same shared modal template (all button states for create/approve/deny/withdraw are pre-rendered together, JS shows only the relevant one) | Exact condition selecting which label renders (create vs. re-request?) — **[UNRESOLVED]**, minor |
| Group Settings / Notification Settings escalation-step editing | Confirmed `dialogMandatoryNotification`/`dialogOptionalNotification` are a **shared component** used identically on both ADM-01 and PL-02 | No functional change to either screen's documented behavior |
| Contacts vs. Users roster-count discrepancy (unresolved-questions.md #60, contradiction C-06) | **Corroborated cross-group**: THP C Site shows 61 Contacts rows vs. 103 Users rows (previously only THP M/Q Site's 66-vs-94 gap was observed) — the same ~30–35% reduction pattern holds in both groups, strengthening confidence this is a systematic filter rather than a one-off | Exact filter rule (which Access Levels/flags are excluded) remains **[UNRESOLVED]** |
| PL-01 Choose List / DASH-01 / PLM-01 (live picklist execution — Phase 8's largest gap) | **State existence confirmed**: the aggregate "currently on pick N out of M picks" progress-bar state is now known to exist and render on Choose List | Execution mechanics (current picker UI, room selection, confirmation, timers, concurrency) remain **deliberately not pursued** — see §12; this is the same standing gap, now with one additional confirmed data point |

---

## 8. Inaccessible or unsafe surfaces

- **Lower-privileged role views** (Staff/Locum/View/Telecom/Genius sidebar/screen visibility) remain inaccessible to this single Scheduler-level account — unchanged since Phase 3, not testable without a second test account or impersonation (prohibited).
- **Live picklist execution UI** for the currently-active list in THP C Site — accessible in principle to this account (same Scheduler-level role holds in both groups), but **deliberately not opened** this pass per explicit instruction. Classified **UNSAFE_TO_OPEN in the context of this audit's brief**, not because the account lacks permission.
- **The two unopened PDF documents** in the Documents library (first identified Phase 8) — still not opened; no new information this pass.
- **Server-side effect of every mutating control** (Save, Publish, Approve, Delete, Lock/Unlock, Sign In As's final submit, and all seven newly-found Send/Add/Create controls in §6) — **UNSAFE_TO_OPEN** by design; every one of this pass's new dialogs was read via hidden-DOM inspection specifically so that no click was required.

---

## 9. External and legacy surfaces

- **Support → Zendesk** (`ischedulemd.zendesk.com`) — unchanged, external, out of scope (recap, SYS-03).
- **Gravatar / Jetpack image proxy / Google Fonts / Bootstrap CDN / Cloudflare cdnjs / Cloudfront (Kendo)** — unchanged third-party dependencies (recap, 10-technical-observations §3, §14).
- **`supportIE7` hidden input** — a legacy IE7-browser-detection artifact found as a `<body>`-level element during this pass's DOM sweep (`<input id="supportIE7">`, not part of any visible nav). Not a navigable surface; noted here only as a minor technical curiosity consistent with the product's dated (2014-era Kendo UI, jQuery 1.9.1) frontend stack already documented in Phase 11. **DUPLICATE_OR_LEGACY**, no action needed.
- **Two Help destinations** (see SM-14, §6) — one real (`build.schedule.pdf`), at least two sharing a placeholder stub (`ComingSoon.pdf`) — a legacy/inconsistent-rollout pattern, not a duplicate screen.

---

## 10. Research updates made

The following existing artifacts were **updated by stable ID, not duplicated**, as part of this audit (see §14 for the mechanical checklist):

- [unresolved-questions.md](unresolved-questions.md): #39 partially resolved (CAL-01), #58 partially resolved for both On Call and Shift Statistics (SM-11, SM-12), #61 resolved (SM-14), #62 resolved for field schema (SM-13); #60/contradiction C-06 strengthened with cross-group corroboration; #10/#51 (live picklist state) updated with the one new confirmed data point, explicitly not closed.
- [source-page-index.md](source-page-index.md): 7 new stable IDs added (CAL-01, SM-10 through SM-14, NAV-03), cross-referencing this report.
- [evidence-register.md](evidence-register.md): this report logged as a text-evidence artifact.
- [manifest.json](manifest.json): this report added to `phaseReports` (unnumbered — see §12 note on not beginning Phase 13).
- [MASTER-CHECKLIST.md](../MASTER-CHECKLIST.md): a new "Final Coverage Audit" line added under Area coverage; no existing checklist line was altered or reversed.

No existing report file (01 through 11) was edited or truncated — every new/updated finding above lives in this report and the four index files, consistent with the project's standing merge-by-reference discipline.

---

## 11. Remaining gaps carried forward

Unchanged from Phase 12's carried-forward list, **plus** the one item below is now more precisely characterized (not closed):

| Gap | Status after this audit |
|---|---|
| Live picklist execution (current picker, timers, room selection, confirmation, failure/retry, concurrency) | **Still open.** This audit newly confirms the aggregate "pick N of M" state exists and is rendered on Choose List; the underlying execution UI and mechanics were deliberately not opened, per explicit instruction. This remains the single largest evidence gap across all research phases to date. |
| Real-time concurrency (connection loss, multi-tab, concurrent selection) | Still open — unchanged. |
| Report-dialog internals for the now **6** known "Create X Report" types (Schedule, Picklist, Stipend, Requests, DayXShift, On Call) plus the newly-found Sharing Statistics Report and Calendar Event dialogs | Field-level schema now known for 2 of the 6 report dialogs (Sharing Statistics, and On Call's title only); the rest remain unopened. |
| The two unopened PDFs | Still open — unchanged. |
| Form validation and error presentation | Still open — unchanged; no form was submitted this pass either. |
| Session/idle timeout, anti-forgery mechanics, SignalR payloads, duplicate-request root cause, date-format response-side consistency, tour-library behaviour | All still open — unchanged, not revisited this pass (out of scope for a navigation-coverage reconciliation). |
| Contacts-vs-Users roster filter rule | Still open, but now cross-group corroborated (§7) rather than single-group anecdotal. |
| Unlabeled `<select>` in the Send Email dialog (SM-13) | **New minor open item** — purpose unresolved (template/signature selector is the most likely guess, unconfirmed). |
| Condition selecting the "REQUEST" vs. "Confirm" button label on the Vacation Block Selection modal | **New minor open item** — unresolved. |

None of these gaps block the classification in §1; all are explicitly out of this audit's scope to close.

---

## 12. Safety-incident-adjacent note: the live picklist

This section is written separately from §1's summary because it is the one event this pass encountered that required an explicit judgment call, even though **no rule was violated and no incident occurred**.

**What happened:** while performing the ordinary, already-established-safe navigation to Choose List (`/app/picklist`) as part of the routine screen-by-screen sweep, the page displayed — for the account's **other** group membership (THP C Site) — a live, in-progress picklist: "currently on pick 1 out of 14 picks," with a rendered progress bar. THP M/Q Site (the group being swept) simultaneously showed its usual "No active picklists" state. This is the exact cross-group aggregation behavior already documented in Phase 8 (PL-01) — the screen did not require switching groups to show this, and switching groups was not what triggered it.

**What was and was not done:**
- **Was done:** the fact was recorded (a picklist is active; the aggregate progress-bar state exists and looks like this). This is ordinary, already-safe navigation to an already-documented screen — no different from any other page load in this or prior phases.
- **Was not done:** the Dashboard (which would show a live, real-time monitor of this specific draft) was not opened. Picklist Manager's row for this specific active list/date was not opened. Choose List was not revisited from within the THP C Site group context to check "is it my turn" (this account is confirmed **not** on that day's list, per the on-screen text, so no turn-based UI would have appeared regardless). No room-selection UI, confirmation flow, or real-time update was observed.

**Why this distinction matters:** the audit's brief explicitly lists "an active picklist" among the deferred gaps that must be **carried forward, not pursued**, even when one becomes incidentally available. Treating an incidental discovery as license to finally close Phase 8's largest gap would have been a scope violation of this specific audit's instructions, regardless of how valuable that data would be. The correct action — taken here — was to note the fact once, generically, and stop.

**No safety incident occurred.** No control was clicked, no data was created or modified, and the one real personal-data field visible on this screen (the account's own contact details, as in every prior phase) is not reproduced in this report.

---

## 13. Whether product consolidation may begin

**Yes.** Per §1: **COVERAGE AUDIT PASSED WITH NON-BLOCKING GAPS — proceed to Phase 13.**

The navigation surface of ischedule.MD, to the full depth reachable by this authorized, Scheduler-level account without a mutating action, has now been swept twice — once across eleven deep-dive phases, once as a dedicated reconciliation pass — with the second pass finding only refinements (seven new passively-observed dialogs/fields, one corroborating data point, one newly-confirmed-but-not-pursued live state) and zero structural surprises (no new top-level screen, no new admin area, no role-visibility change, no broken/orphaned page). Every gap that remains open was already known, already carried forward by name in Phase 12's edge-case catalogue, and is explicitly out of scope for a coverage-reconciliation pass to close. There is no indication that continuing broad exploration would surface materially different findings than the two passes already completed.

**Per this audit's explicit instruction: Phase 13 (broad research against ischedule.MD) is not begun by this report.** The phrase "proceed to Phase 13" in the verdict above reflects only that the *coverage gate* is satisfied, i.e. that SchedulePoint's product-consolidation work may now proceed with confidence that the research base is complete — it is not this report initiating that next phase itself.

---

## 14. Validation checklist

- [x] `reports/final-coverage-audit.md` created and non-empty
- [x] `reports/manifest.json` remains valid JSON after update
- [x] All new stable IDs (CAL-01, SM-10, SM-11, SM-12, SM-13, SM-14, NAV-03) are unique — no collision with any ID in reports 01–11
- [x] Every evidence reference above resolves to an existing report section or a newly-logged evidence-register.md row
- [x] No existing report (01–11) was truncated or altered
- [x] No credentials, tokens, cookie values, patient information, or unnecessary personal data were saved anywhere in this report (the account's own name/email/phone, visible during this pass exactly as in every prior phase, are not reproduced)
- [x] All counts/summary statements above (22-route sidebar parity, 61/103 and 66/94 Contacts-vs-Users counts, 6 known report-dialog types) agree with the underlying observations recorded in this report
