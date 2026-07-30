# Source Page Index

Tracks every distinct page/screen discovered in SchedulePoint, where it lives in the navigation, and where its evidence is stored.

Do not include names, phone numbers, patient details, or other sensitive data — describe screens generically.

| # | Area | Screen / Page Name | Navigation Path | Evidence Folder | Screenshot Files | Status | Notes |
|---|------|--------------------|------------------|------------------|-------------------|--------|-------|
| 1 | navigation | NAV-01 Top bar | persistent chrome | screenshots/navigation/ | nav-topbar-01.png (pending capture) | documented | See [01-application-map.md](01-application-map.md) |
| 2 | navigation | NAV-02 Left sidebar | persistent chrome | screenshots/navigation/ | nav-sidebar-01.png (pending capture) | documented | |
| 3 | schedule | SCH-01 My Schedule | Sidebar > My Schedule (`/app`) | screenshots/schedule/ | my-schedule-01.png (pending capture) | documented | Swap Shift + Opportunity Board not exercised |
| 4 | schedule | SCH-02/03/04 Master Schedule (Date/Staff/Shift View) | Sidebar > Master Schedule (`/app/schedulenew`) | screenshots/schedule/ | master-schedule-dateview-01.png, -staffview-01.png, -shiftview-01.png (pending capture) | documented | Batch Add/Delete not exercised |
| 5 | schedule | SCH-05 On Call | Sidebar > On Call (`/app/oncalltoday`) | screenshots/schedule/ | on-call-today-01.png (pending capture) | documented | |
| 6 | vacation | VAC-01 Vacation grid | Sidebar > Vacation (`/vacation/index`) | screenshots/vacation/ | vacation-grid-01.png (pending capture) | documented | Near-miss: badge click opens delete-confirm modal, see report §7 |
| 7 | vacation | VAC-02 Vacation Settings | Vacation > Settings (`/admin/vacationmanagement`) | screenshots/admin/ | vacation-settings-01.png (pending capture) | documented | Cancelled without saving |
| 8 | schedule | DA-01 Daily Assignments | Sidebar > Daily Assignments (`/app/viewplm`) | screenshots/schedule/ | daily-assignments-01.png (pending capture) | documented | |
| 9 | picklist | PL-01 Choose List | Sidebar > Choose List (`/app/picklist`) | screenshots/picklist/ | choose-list-01.png (pending capture) | documented | No active picklists during review |
| 10 | picklist | PL-02 Notification Settings | Choose List > Modify Notifications (`/users/notifications`) | screenshots/picklist/ | notification-settings-01.png (pending capture) | documented | Not saved |
| 11 | picklist | PL-03 User Profile | Choose List > Modify phone numbers (`/users/profile`) | screenshots/picklist/ | user-profile-01.png (pending capture) | documented | Not saved |
| 12 | navigation | CON-01 Contacts | Sidebar > Contacts (`/app/contacts`) | screenshots/navigation/ | contacts-01.png (pending capture) | documented | Send Email/SMS/Export not exercised |
| 13 | admin | DOC-01 Documents | Sidebar > Documents (`/app/documents`) | screenshots/admin/ | documents-01.png (pending capture) | documented | Add Category/Upload not exercised |
| 14 | picklist | PLM-01 Picklist Manager | Sidebar > Picklist Manager (`/admin/picklists`) | screenshots/picklist/ | picklist-manager-01.png (pending capture) | documented | Core draft mechanism; no mutating action taken |
| 15 | admin | DASH-01 Dashboard | Top bar > Dashboard (`/admin/picklistmonitordashboard`) | screenshots/admin/ | dashboard-01.png (pending capture) | documented | No active lists during review |
| 16 | admin | ADM-01 Group Settings | Scheduling > Group Settings (`/admin/groups`) | screenshots/admin/ | group-settings-01.png (pending capture) | documented | |
| 17 | admin | ADM-02 Builds | Scheduling > Builds (`/admin/builds`) | screenshots/admin/ | builds-01.png (pending capture) | documented | Contains "Erase Master Schedule" — not clicked |
| 18 | admin | ADM-03 Staff Shift FTE | Scheduling > Staff Shift FTE (`/admin/staffshiftfte`) | screenshots/admin/ | staff-shift-fte-01.png (pending capture) | documented | |
| 19 | admin | ADM-04 Shift Statistics | Scheduling > Statistics (`/admin/shiftstatistics`) | screenshots/admin/ | shift-statistics-01.png (pending capture) | documented | |
| 20 | admin | ADM-05 Staff (Users) | Scheduling > Staff (`/admin/users`) | screenshots/admin/ | staff-users-01.png (pending capture) | documented | Role model source; Edit opened then cancelled |
| 21 | admin | ADM-06 Staff Groups | Scheduling > Staff Groups (`/admin/staffgroup`) | screenshots/admin/ | staff-groups-01.png (pending capture) | documented | |
| 22 | admin | ADM-07 Shifts | Scheduling > Shifts (`/admin/shifts`) | screenshots/admin/ | shifts-01.png (pending capture) | documented | Shift-type master catalog |
| 23 | admin | ADM-08 Shift Groups | Scheduling > Shift Groups (`/admin/shiftgroup`) | screenshots/admin/ | shift-groups-01.png (pending capture) | documented | Explains request-off tooltip mechanism |
| 24 | admin | ADM-09 Valid Groups | Scheduling > Valid Groups (`/admin/validgroups`) | screenshots/admin/ | valid-groups-01.png (pending capture) | needs review | Purpose unresolved; Edit not opened |
| 25 | admin | ADM-10 Pattern Rules | Scheduling > Pattern Rules (`/admin/patterns`) | screenshots/admin/ | pattern-rules-01.png (pending capture) | documented | Core fairness/spacing rule engine |
| 26 | navigation | SYS-01 Site/Group switcher | Top bar (site dropdown) | screenshots/navigation/ | site-switcher-01.png (pending capture) | documented | Not switched, to preserve session |
| 27 | navigation | SYS-02 User account menu | Top bar (user dropdown) | screenshots/navigation/ | user-menu-01.png (pending capture) | documented | "Sign In As" impersonation not exercised |
| 28 | navigation | SYS-03 Support | Top bar > Support (external Zendesk) | n/a | n/a | documented | Third-party, out of scope |
| 29 | navigation | SYS-04 Tour | Top bar > Tour | n/a | n/a | needs review | Did not visibly trigger; purpose unresolved |
| 30 | admin | ADM-11 Staff Rules | Scheduling > Staff Rules (`/admin/staffrules`) | screenshots/admin/ | staff-rules-01.png (pending capture) | documented | Phase 3; missed in Phase 1, found via DOM sweep. Per-individual penalty/constraint engine |
| 31 | navigation | SYS-05 Sign In As | Top bar > user menu > Sign In As (`/admin/signas`) | screenshots/admin/ | sign-in-as-01.png (pending capture) | documented | Phase 3; two-step form (Group + Staff + Sign In), form loaded but never submitted |
| 32 | navigation | GRP-01 Group/site switching behavior | Top bar (site dropdown), cross-referenced against `/admin/users` under each group | screenshots/navigation/ | n/a — behavioral finding, not a single screen | documented | Phase 3; confirmed per-group user rosters, per-group role assignment, per-group request-window state |
| 33 | admin | ROLE-01 Role-permission matrix | Synthesized from ADM-05 (both groups) + dropdown option scan | reports/ | n/a | documented | Phase 3; see [02-role-permission-matrix.md](02-role-permission-matrix.md) §8 |
| 34 | requests | WF-01 Login | Unauthenticated — not reachable from an authenticated session | n/a | n/a | needs review | Phase 4; deliberately unobserved (no recovery credentials) |
| 35 | requests | WF-02 Password reset | Unauthenticated | n/a | n/a | needs review | Phase 4; deliberately unobserved |
| 36 | navigation | WF-03 Group/site switching (workflow detail) | Top bar site dropdown | screenshots/navigation/ | n/a | documented | Phase 4; expands GRP-01 with exact navigation sequence |
| 37 | schedule | WF-04 View personal schedule (workflow detail) | `/app` | screenshots/schedule/ | n/a | documented | Phase 4; expands SCH-01 with per-date-state system responses |
| 38 | schedule | WF-05 / WF-05a Master Schedule cell editor + audit log | `/app/schedulenew` own-row cell click | screenshots/schedule/ | my-schedule-cell-editor-01.png (pending) | documented | Phase 4/5; major new finding — full change-provenance log per cell |
| 39 | requests | WF-08 Vacation/OFF request creation | `/vacation/index` empty cell click | screenshots/vacation/ | n/a | documented | Phase 4; "Vacation Block Selection" modal, not submitted |
| 40 | requests | WF-09 Vacation withdrawal/denial | `/vacation/index` existing badge click | screenshots/vacation/ | n/a | documented | Phase 4; Cancel/Save Comment/Remove/Deny — none clicked |
| 41 | requests | WF-10 Request status viewing (PENDING/ALL) | `/app` My Requests panel | screenshots/schedule/ | n/a | documented | Phase 4; full history back to 2022 confirmed |
| 42 | requests | WF-11/12 Opportunity post/remove | `/app` future date cell + Opportunity Board | screenshots/schedule/ | n/a | documented | Phase 4; corroborated by WF-05a audit log wording "moved as opportunity" |
| 43 | requests | WF-13 Shift swap | `/app` Swap Shift modal | screenshots/schedule/ | n/a | documented | Phase 4; Cancel used, not submitted |
| 44 | picklist | WF-23 Calendar subscription | `/app` Subscribe modal | screenshots/picklist/ | n/a | documented | Phase 4; webcal:// URL structure documented, token redacted |
| 45 | schedule | Cell editor: Shifts/Credits display split | `/app/schedulenew` cell editor "Display" selector | screenshots/schedule/ | n/a | documented | Phase 5; major finding — shift assignment and fairness credit are independently movable per cell |
| 46 | schedule | Build lock/unlock vs. cell-edit interaction | `/admin/builds` + `/app/schedulenew` | screenshots/schedule/ | n/a | needs review | Phase 5; whether Locked builds also block direct cell edits was deliberately not tested |
| 47 | schedule | Full shift-code legend (30 codes) | `/app/schedulenew` Staff View legend | reports/04-master-schedule.md §2 | n/a | documented | Phase 5; generic operational vocabulary, safe to reproduce in full |
| 48 | admin | Build Setup full field inventory | `/admin/schedulebuildsmanagement?buildId=N` | screenshots/admin/ | build-setup-01.png (pending) | documented | Phase 6; Progressive Build chain, Solve In Order of MIN Staff, chip-list scoping |
| 49 | admin | Pattern Rule Setup authoring form | `/admin/patternsmanagement` (Add New) | screenshots/admin/ | pattern-rule-setup-01.png (pending) | documented | Phase 6; resolves Hard vs Weight Penalty and Optimal Spacing vs Day Offset |
| 50 | admin | Staff Rule Setup authoring form | `/admin/staffRulesmanagement` (Add New) | screenshots/admin/ | staff-rule-setup-01.png (pending) | documented | Phase 6; 5 THEN-action types (Assign/Penalty/Exclude/Linked/Staff-Shift), Staff-Balance-conditioned IF |
| 51 | admin | Valid Group Setup (Group One / Group Two) | `/admin/schedulevalidgroupsmanagement?validGroupId=N` | screenshots/admin/ | valid-group-setup-01.png (pending) | documented | Phase 6; resolves Phase 1 open question — restricts shift codes to specific pick-order positions |
| 52 | admin | "Pick Shifts" number-of-positions modal | `/admin/shifts` (Picks header button) | screenshots/admin/ | pick-shifts-01.png (pending) | documented | Phase 6; group-wide pick-position count (30), one-way increase-only constraint |
| 53 | vacation | LC-01a Batch Approval (vacation) | `/vacation/index` Approve button | screenshots/vacation/ | n/a | documented | Phase 7; date-range bulk approve, not submitted |
| 54 | vacation | LC-01b TRANSFER VACATIONS TO MASTER SCHEDULE | `/vacation/index` TRANSFER button | screenshots/vacation/ | transfer-vacations-01.png (pending) | documented | Phase 7; **major finding** — irreversible, type-to-confirm ("PUBLISH") batch write into Master Schedule; not submitted |
| 55 | vacation | Batch Entry Off/On menu | `/vacation/index` Batch Entry Off ▾ | screenshots/vacation/ | n/a | needs review | Phase 7; only opened to menu-label level, form content unresolved |
| 56 | requests | LC-02 Shift-group-scoped "OFF {X}" requests | unresolved — creation surface not located | screenshots/requests/ | n/a | needs review | Phase 7; history/status observed via WF-10, creation path still open |
| 57 | picklist | Picklist Import (Staff/Work) re-sync confirmation | `/admin/picklists` Import buttons | screenshots/picklist/ | n/a | documented | Phase 8; NOT a file upload — erase-and-resync confirmation only; external OR-slate file import mechanism still unlocated |
| 58 | picklist | Room creation control ("Add Room") — SAFETY INCIDENT | `/admin/picklists` Work panel Add button | screenshots/picklist/ | n/a | documented | Phase 8; **creates instantly, no preview/confirm** — see reports/07-picklist-system.md §0 for full incident record; accidental room deleted immediately after creation |
| 59 | picklist | Choose List cross-group aggregation | `/app/picklist` | screenshots/picklist/ | n/a | documented | Phase 8; shows both group memberships' active-picklist status on one screen without switching context |
| 60 | picklist | Picklist Manager "last synced N minutes ago" staleness indicator | `/admin/picklists` | screenshots/picklist/ | n/a | documented | Phase 8; evidence against a pure real-time push model — manual refresh control present |
| 61 | picklist | Completed picklist Email distribution modal | `/admin/picklists` Email button on COMPLETED row | screenshots/picklist/ | n/a | documented | Phase 8; "Pick List / Work Assignment / Both" choices, not sent |
| 62 | navigation | SM-01 Help stub link | `/vacation/index` Help button | n/a | n/a | documented | Phase 9; href = `/Help/ComingSoon.pdf` — unimplemented placeholder, not opened |
| 63 | schedule | SM-02 Print/Export/Share controls (Master Schedule, On Call, Shift Statistics) | multiple screens | screenshots/schedule/,screenshots/admin/ | n/a | needs review | Phase 9; existence/labels catalogued via DOM only, none activated; Stipend confirmed as export-type-only, no dedicated screen |
| 64 | navigation | SM-03 Contacts row interactivity | `/app/contacts` | n/a | n/a | needs review | Phase 9; cursor:pointer observed, click deliberately untested — future test requirement recorded |
| 65 | navigation | SM-05 Documents — no search/filter exists | `/app/documents` | n/a | n/a | documented | Phase 9; confirmed via full interactive-element read |
| 66 | admin | SM-09 Full navigable surface — negative finding | all screens | n/a | n/a | documented | Phase 9; no new screens found beyond existing inventory after a final link/href sweep |
| 67 | schedule | RA-01 App shell responsive breakpoint (sidebar→hamburger) | all screens | screenshots/schedule/ | n/a | documented | Phase 10; breakpoint bracketed 768-1512px, exact value unresolved |
| 68 | schedule | RA-02 Calendar/schedule grid shrink-to-fit behavior | `/app`, `/app/schedulenew` | screenshots/schedule/ | n/a | documented | Phase 10; no horizontal overflow at phone width, confirmed via scrollWidth measurement |
| 69 | navigation | RA-03 Contacts table horizontal overflow — layout failure | `/app/contacts` | screenshots/navigation/ | n/a | documented | Phase 10; 270px overflow at phone width, page-level not table-scoped scroll; screenshot contains real PII, not reproduced in report |
| 70 | schedule | RA-07 Global focus-visibility gap (outline:none) | all screens | n/a | n/a | documented | Phase 10; **F-01 high-priority recommendation** — no visible focus indicator found on any sampled element |
| 71 | schedule | RA-12 Heading hierarchy gap + bonus Print-menu resolution | `/app/schedulenew` | n/a | n/a | documented | Phase 10; **F-03 high-priority recommendation**; also resolved unresolved-questions.md #57 via passive heading-text read |
| 72 | schedule | RA-13/14 ARIA labeling gaps (unlabeled buttons, unlabeled dialogs) | `/app/schedulenew` | n/a | n/a | documented | Phase 10; **F-02/F-04 high-priority recommendations** — Prev/Next date arrows confirmed unlabeled across nearly every schedule screen |
| 73 | schedule | RA-09/10 Modal focus trap + Escape-to-close — positive findings | `/app` Swap Shift modal | n/a | n/a | documented | Phase 10; **F-08 recommendation to preserve this pattern** |
| 74 | admin | TECH-04 pickordersadmin duplicate-request defect | `/admin/picklists` row selection | n/a | n/a | documented | Phase 11; **T-01 high-priority recommendation** — ~25-40x identical GET requests from one click |
| 75 | schedule | API-05..14 catalogue (works/workdays/requests/opportunities/shiftgroup/VacationYear/picklistsadmin/pickordersadmin) | multiple `/api/*` endpoints | n/a | n/a | documented | Phase 11; sanitized route patterns, see reports/10-technical-observations.md §5 |
| 76 | navigation | SignalR "picklist" real-time hub confirmed | all pages (connects on every load) | n/a | n/a | documented | Phase 11; partially resolves Phase 8's real-time gap — hub exists and connects, message content still unresolved (picklist never active) |
| 77 | navigation | Gravatar third-party avatar request (hashed email) | all pages | n/a | n/a | documented | Phase 11; privacy finding — **T-05 recommendation**, hashed identifier sent to third party on every page load |
| 78 | navigation | Zendesk support widget 503-broken | all pages | n/a | n/a | documented | Phase 11; **T-08 recommendation** — silently broken third-party integration, no user-visible fallback |

## Legend

- **Status**: `not started` / `in progress` / `documented` / `needs review`
- **Area**: one of navigation, schedule, requests, vacation, picklist, admin, errors

## How to add an entry

1. Assign the next sequential `#`.
2. Fill in the navigation path exactly as clicked through the UI (e.g. `Main Menu > Schedule > Week View`).
3. Reference evidence filenames already saved under the matching `screenshots/<area>/` folder.
4. Cross-link any related entry in [evidence-register.md](evidence-register.md).
