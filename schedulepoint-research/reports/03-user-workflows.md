# 03 — User-Facing Workflows: ischedule.MD

**Phase:** 4 — ordinary user/physician workflow inventory.

**Method:** Read-only inspection per [RESEARCH-RULES.md](../RESEARCH-RULES.md). Forms and confirmation dialogs were opened to inspect fields, defaults, and validation copy; every one was dismissed via Cancel/Close, never submitted. Merges by stable ID into [01-application-map.md](01-application-map.md) and [02-role-permission-matrix.md](02-role-permission-matrix.md) — screens already described there (SCH-01, VAC-01, PL-01/02/03, CON-01, DOC-01, SCH-05, DA-01) are referenced, not redescribed.

**Evidence labels:** **[OBSERVED]** · **[INFERRED]** · **[UNRESOLVED]**.

**Exclusions honored:** no real names/emails/phones/tokens reproduced. Where a workflow's evidence required reading a personal calendar-subscription URL, the URL's structure is described but its authentication token is not reproduced (see WF-23). Clinical case-level detail (patient ages/procedures) appeared incidentally on SCH-01's shift-detail panel during this phase; it is described generically only.

---

## WF-01 — Login

- **Actor:** any user
- **Preconditions:** none (unauthenticated)
- **Status:** **[UNRESOLVED]** — deliberately not observed. The reviewing session was authenticated for the entire engagement and has no credentials to re-authenticate with. Signing out to observe the login form was judged too high-risk (irreversible loss of access for the remainder of this and all subsequent phases) and was not attempted, consistent with RESEARCH-RULES' "if safety is uncertain, do not perform it."
- **What was observed instead [OBSERVED]:** the marketing homepage (`/`) has a **Sign In** button. Clicking it while already authenticated (tested in a disposable second tab, then closed) redirects straight into `/app` — confirming the session cookie is shared across tabs in the same browser profile and that `/` is a separate, ungated marketing route from the authenticated app.
- **Unanswered questions:** actual login form fields (username/email + password? SSO? MFA?), error states for bad credentials, account lockout behavior, "remember me" options — all **[UNRESOLVED]**.

## WF-02 — Password reset

- **Status:** **[UNRESOLVED]** for the same reason as WF-01 (would require an unauthenticated context). PL-03 (`/users/profile`) does have a self-service **Change Password** section for an *already-authenticated* user (Current/New/Re-type + Change password button) — see WF-19 — but a "forgot password" recovery flow for a logged-out user was not observed.

## WF-03 — Group/site switching

- **Actor:** any user belonging to more than one group (confirmed for this session's Scheduler-level account; unresolved for other roles)
- **Preconditions:** account has membership in ≥2 groups
- **Starting screen:** any authenticated page (top bar is persistent)
- **Navigation sequence [OBSERVED]:** click the site-name dropdown in the top bar (e.g. "THP M/Q Site ▾") → a 2-item list appears (the account's groups) → click the other group's name → page reloads with the new `groupId` in the URL hash, staying on the same route (e.g. `/app` → `/app` under the new group).
- **Observable system response:** every data-bound screen re-scopes silently to the new group. Confirmed differences across groups in this session: independent user rosters (94 vs. 103 rows), independent request-window state ("(CLOSED)" vs. "(UNTIL DECEMBER 18, 2026)" on the My Requests panel), and — per Phase 3 — a person's Access Level can differ between groups.
- **Statuses/transitions:** session-only context change; **not persisted** (distinct from WF-20's saved default group).
- **Evidence:** GRP-01 (02-role-permission-matrix.md §4)
- **Unanswered questions:** whether a lower-privileged role sees the same switcher; whether switching mid-task (e.g. mid-request-draft) discards in-progress state. **[UNRESOLVED]**

## WF-04 — View personal schedule

- **Actor:** any authenticated user
- **Starting screen:** Sidebar → My Schedule (`/app`), the default landing page.
- **Navigation sequence [OBSERVED]:** land on `/app` → month calendar renders for the current month, "today" highlighted → click Prev/Today/Next or the **Date ▾** picker to change month → click any day cell → right-hand **Date Details** panel updates to that date.
- **Fields/controls:** Print, Subscribe (see WF-23), Date ▾ (calendar widget), Prev/Today/Next, day cells, Date Details mini date-strip (7-day window), Opportunity Board panel, My Requests panel.
- **Observable system responses by date state [OBSERVED, new in this phase]:**
  - **Past date, already worked:** Date Details shows a **"Shifts below are completed"** banner, then a read-only breakdown of what was worked that day (role label + generic case-type description).
  - **Future date the user holds a pick for, not yet resolved:** Date Details shows **"`<Nth>` - Not picked yet"** — confirms picks resolve progressively over time rather than all being generated at once.
  - **Future date with a resolved shift:** Date Details shows the shift's full description (name, recurrence note, e.g. "Wednesdays and Fridays," component parts) plus **POST OPPORTUNITY** and **SWAP SHIFT** action buttons (see WF-11, WF-13).
  - **Today, with clinical assignments:** Date Details shows a case-level work list under "Today's Shifts" (not reproduced — see exclusions).
  - Calendar cells for dates carrying a posted-opportunity get a heart icon (❤), matching the Opportunity Board panel's own icon — confirms a direct visual link between the calendar grid and the Opportunity Board list.
- **Evidence:** SCH-01
- **Unanswered questions:** behavior for a date beyond the published Schedule End Date (Group Settings). **[UNRESOLVED]**

## WF-05 — View organization schedule

- **Actor:** any user with Master Schedule visibility (confirmed for Scheduler; **[UNRESOLVED]** for Staff/Locum/View/Telecom)
- **Starting screen:** Sidebar → Master Schedule (`/app/schedulenew`)
- **Navigation sequence [OBSERVED]:** land on Date View by default → switch **Date View ▾** to Staff View or Shift View → adjust **1 Week ▾**–**8 Weeks** range → step with Prev/Today/Next or the Date ▾ picker.
- Full control/field inventory already documented at SCH-02/03/04; this phase adds:
  - Clicking a cell in **your own row** (Date View) opens a **cell editor modal** titled "`<Staff Name>` - `<Date>`" with tabs **Display / Shifts / Credits**, a "Type shift to add… + Add" control, the cell's current pick label (e.g. "5th Pick"), a "Staff for move shift or credit" selector + **Move Shift** button, a guidance note ("Move picks when possible, use Picklist Control to add or delete picks"), and — critically — a **reverse-chronological audit/provenance log** of every prior change to that cell (see WF-05a below). **Close Window** dismisses without acting. This modal was **not** limited to admin cells; it opened identically on the reviewing account's own name, so it is plausibly the same editor available to any Scheduler-level (or higher) account for any staff row, not a special "my own row" case. **[INFERRED — not cross-checked against a second staff member's row this phase]**
- **Evidence:** SCH-02/03/04, expanded in 04-master-schedule.md

### WF-05a — Master Schedule cell audit/provenance log (new finding this phase)

- **[OBSERVED]** Each entry in the log reads: `<action description> by <actor> [(<mechanism tag>)]. <timestamp>`. Action types seen: `"<Shift> moved as opportunity to <Person> by <Person>"` (a give-away being logged — ties WF-11 directly to this log), `"<Nth> Pick changed to <Nth> Pick by <Person> (PLC)"` (a pick-order change made through the picklist-pick interface itself, tagged `(PLC)` — most plausibly "Pick List Control"), and `"<Nth> Pick reassigned to <Person> by <Person>"` / `"<Shift> reassigned to <Person> by <Person>"` (no tag — an admin-driven reassignment, presumably made via this same Master Schedule cell editor).
- **Data model implication:** every mutation to a schedule cell is captured as an immutable, human-readable log entry with actor, action, and timestamp — a genuine audit trail, not just a "last modified by" field. This is one of the most valuable findings of this phase for SchedulePoint's own data-model design (see 04-master-schedule.md §"Audit/provenance").
- **Confidence:** High (directly observed) for the log's existence and shape; **[UNRESOLVED]** whether it is exhaustive (captures literally every change) or only certain change types, and whether staff themselves (not just admins) can view this log for their own cells, or if it's admin-only.

## WF-06 — Date/schedule-range navigation

Common pattern across My Schedule, Master Schedule, On Call, Vacation, Daily Assignments, and Shift Statistics: a **Date ▾** dropdown opening a calendar-month picker, plus **Prev/Today/Next** stepper buttons, plus (on Master Schedule and Vacation) a separate **N-weeks/N-months** range-length selector. All confirmed client-navigable without any save step — pure view state carried in the URL. **[OBSERVED]**

## WF-07 — Shift detail inspection

- Covered inline under WF-04/WF-05. Additional evidence: On Call's phone "chips" (SCH-05) were checked this phase via DOM inspection and **do not** use `tel:` links — **[OBSERVED]** they are plain styled elements, not click-to-call — resolving a Phase 1 open question.

## WF-08 — Vacation/OFF request creation (the actual "request" workflow)

This is the concrete answer to Phase 1's open question "where do staff actually file a new request" — for the **vacation/weekly-OFF** request type, at least.

- **Actor:** any staff member with a row on the Vacation grid, for their **own** row only (confirmed — clicking another staff member's empty cell was not tested, to avoid initiating a request on someone else's behalf; **[UNRESOLVED]** whether that's even possible for a Scheduler)
- **Preconditions:** the target week must fall within the active Vacation Block (VAC-02); the cell must currently be **empty** (no existing badge)
- **Starting screen:** Vacation (`/vacation/index`)
- **Navigation sequence [OBSERVED]:** locate own row → click an empty week-column cell → a **"Vacation Block Selection"** modal opens.
- **Fields:** a **"Comments for Scheduler"** free-text textarea (optional, empty by default); no other input fields — the week itself is fixed by which cell was clicked.
- **Defaults:** Comments empty.
- **Validation observed:** none client-side beyond the cell being clickable only within the active block's columns.
- **Confirmation copy [OBSERVED]:** *"Please confirm that you wish to select the week of `<Start>` (Saturday) to `<End>` (Sunday) for Dr. `<Name>`?"* with a status tag **"Approval required from Scheduler"** shown whenever VAC-02's "Approval Required By Scheduler" is Yes (confirmed set to Yes in this tenant).
- **Actions:** **Cancel** (dismiss, no effect — used here) / **Confirm** (submit — not exercised).
- **Observable system response if confirmed [INFERRED, not executed]:** based on the badge-click behavior seen elsewhere (VAC-01) and the "Approval required" tag, submitting almost certainly creates a **pending** vacation-week entry (an amber-colored badge per the color convention already documented in VAC-01) that then requires a Scheduler to **Approve** before it becomes a firm "off" week.
- **Notifications:** **[UNRESOLVED]** whether submission triggers an email/SMS to the scheduler or to Admin-Emails-flagged accounts (Telecom-role accounts, see 02-role-permission-matrix.md, are prime candidates given their flag pattern).
- **Statuses/transitions:** empty cell → (Confirm) → pending badge (amber, inferred) → Scheduler Approve/Deny → approved badge (green, confirmed color from VAC-01) or removed.
- **Alternate/failure paths:** clicking an **existing** badge instead of an empty cell opens a **different** modal — see WF-09 (withdrawal), not creation. This is a notable UX overload: the same grid surface serves two entirely different actions (create vs. delete) depending on cell state, with no visible affordance distinguishing them until clicked.
- **Evidence:** VAC-01, VAC-02
- **Unanswered questions:** whether "OFF {`<Shift Group>`}"-style requests seen in WF-10's history (e.g., call-group opt-outs distinct from vacation weeks) are created through this same interaction against a different shift-group column, or through an entirely separate screen not found this phase. **[UNRESOLVED]** — searched My Schedule and Vacation thoroughly; no distinct "request off a specific call type" creation control was found outside the Vacation grid's own week-cell click.

## WF-09 — Vacation request withdrawal / scheduler denial (existing-badge click)

- **Actor:** the request's own staff member (withdrawal) or a Scheduler (deny)
- **Starting screen:** Vacation (`/vacation/index`)
- **Navigation sequence [OBSERVED]:** click an existing colored badge in any row → **"Vacation Block Selection"** modal opens, defaulting straight to a delete-style confirmation.
- **Confirmation copy [OBSERVED]:** *"Do you wish to delete the week of `<Start>` to `<End>` for Dr. `<Name>`?"* with the same "Approval required from Scheduler" tag, a **Comments for Scheduler** box (pre-populated with prior comment text in the observed instance, plus a visible **Timestamp**), and **four** actions: **Cancel / Save Comment / Remove / Deny**.
- **Two distinct destructive actions on one screen:** **Remove** (the requester or an admin retracting/deleting the entry) vs. **Deny** (a Scheduler-only rejection of a pending request) — both present simultaneously regardless of the badge's actual status in the instance observed, so the UI does not appear to hide "Deny" from a non-Scheduler viewing their own approved entry. **[OBSERVED the buttons coexist; INFERRED that server-side authorization still gates who can actually invoke Deny]**
- **Save Comment:** a partial-save action (adds/edits the comment without resolving the request) — distinct from Remove/Deny. Not exercised.
- **None of Remove / Deny / Save Comment were clicked.** Only **Cancel** was used.
- **Evidence:** VAC-01 §"near-miss" (01-application-map.md §7)
- **Unanswered questions:** exact difference in server effect between Remove and Deny (both likely end with the week no longer counted, but may differ in notification text or whether the requester can immediately re-request the same week). **[UNRESOLVED]**

## WF-10 — Request status viewing

- **Actor:** any user, own requests only
- **Starting screen:** My Schedule (`/app`), **My Requests** panel
- **Navigation sequence [OBSERVED]:** panel loads showing a header state — **"(CLOSED)"** or **"(UNTIL `<date>`)"** depending on the active group's Request Until Date — with a filter toggle button reading **PENDING** or **ALL**. Clicking the toggle switches between "only currently-pending items" and the full historical log.
- **Full-history schema [OBSERVED]:** Status badge (**APPROVED** seen; PENDING/DENIED presumed by symmetry — **[INFERRED]**), Date (the requested-off date, not the filing date), request description in the form **"OFF {`<Shift Group name>`}"**, and a **DELETE** button per row — present even on already-**APPROVED** rows, meaning a user can apparently retract a request after the fact via this panel too (a second withdrawal surface distinct from WF-09's Vacation-grid badge click — **[UNRESOLVED]** whether these DELETE buttons on this panel and the Remove button on the Vacation grid hit the same underlying record for vacation-type requests, or whether this panel is scoped to the non-vacation "{Shift Group}" request type only).
- History observed spanning back to 2022 — confirms no rolling-window truncation of the user's own request history.
- **Evidence:** SCH-01
- **Unanswered questions:** see WF-08's note on where "{Shift Group}" requests are created; also whether DELETE on an APPROVED row requires re-approval of the deletion itself, or is immediate. **[UNRESOLVED]**

## WF-11 — Post opportunity (shift give-away)

- **Actor:** the staff member who currently holds a future, not-yet-completed pick
- **Preconditions:** date must be in the future relative to "today"
- **Starting screen:** My Schedule (`/app`), a future date cell
- **Navigation sequence [OBSERVED]:** click a future date cell you hold a pick for → Date Details panel shows a green **POST OPPORTUNITY** button (appears only for future dates — confirmed absent for past/today dates) → (not clicked further).
- **Observable downstream effect [OBSERVED via corroborating evidence, action itself not executed]:** entries already present on the Opportunity Board panel, when expanded, show the poster's own name plus a **Remove** button — directly matching the reviewing account's own identity in every entry checked (2 of the ~7 visible were expanded and checked). This strongly indicates **POST OPPORTUNITY** is exactly what populates the Opportunity Board, and the panel's own **Remove** button (see WF-12) is its undo.
- **Notifications:** **[UNRESOLVED]** whether posting notifies other eligible staff (plausible, given the product's phone/SMS/email notification-escalation infrastructure documented in Phase 1/3) or is purely a passive "board" others must check.
- **Evidence:** SCH-01; corroborated by the Master Schedule cell audit log (WF-05a), which recorded a `"<Shift> moved as opportunity to <Person> by <Person>"` entry — confirming server-side terminology literally uses "opportunity" for this action.

## WF-12 — Remove a posted opportunity

- **Actor:** the original poster (only tested case)
- **Starting screen:** My Schedule, Opportunity Board panel
- **Navigation sequence [OBSERVED]:** click a row in the Opportunity Board list → row expands inline to show the poster's name and a **Remove** button → (not clicked).
- **Evidence:** SCH-01
- **Unanswered questions:** whether any *other* eligible staff member's action ("claim") appears on this same expanded row, or happens elsewhere entirely (e.g., a separate "claim" flow reachable only by someone other than the poster, which this single-account session cannot observe). **[UNRESOLVED — likely, but not confirmed, given every entry checked belonged to the reviewing account itself]**

## WF-13 — Shift swap

- **Actor:** a staff member with an upcoming pick, proposing a swap with a named colleague
- **Starting screen:** My Schedule, **SWAP SHIFT** button (present for both past-today and future dates, unlike POST OPPORTUNITY which is future-only)
- **Navigation sequence [OBSERVED]:** click SWAP SHIFT → **"Swap - `<Date>`"** modal opens.
- **Fields [OBSERVED]:** a checklist of the user's own upcoming picks eligible for swapping (each row: date + pick label + checkbox — two shown: the clicked date and the next one), a **"Staff for swap"** searchable combobox (options not enumerated — custom widget, left unopened to avoid unnecessary personal-data capture per RESEARCH-RULES data-handling guidance), **Cancel** / **Swap Shifts** buttons.
- **Defaults:** no shifts pre-checked; no staff pre-selected.
- **Validation:** not observed (form was not submitted).
- **Notifications:** **[UNRESOLVED]** — plausibly notifies the proposed swap partner, given the app's messaging infrastructure, but not confirmed.
- **Statuses/transitions:** **[UNRESOLVED]** whether a swap requires the other party's acceptance (a true two-sided negotiation) or is a Scheduler-approved unilateral request like vacation. Given "Approval Required By Scheduler" exists as a vacation-specific setting and no equivalent was seen for swaps specifically, a partner-acceptance model is at least as plausible. **[INFERRED, low confidence]**
- **Evidence:** SCH-01

## WF-14 — On-call directory viewing

Already fully documented at SCH-05 (01-application-map.md). This phase adds only the `tel:`-link finding under WF-07.

## WF-15 — Daily assignments viewing

Already fully documented at DA-01. No new interaction surface found this phase beyond what Phase 1 recorded (date picker, Comments banner, Work list, Assigned Positions directory).

## WF-16 — Contacts directory + bulk actions

Already documented at CON-01. This phase confirms the quick filters (**All/Staff/Locum/None**) are pure client-side view filters (clicking "All" while already on "All" produced no network activity/visible change) — **[OBSERVED]**. Bulk **Send Email / Send SMS / Export / Print** were not exercised (messaging and file-export actions are out of scope for read-only review).

## WF-17 — Documents browsing

Already documented at DOC-01. Category-click behavior (loading a file list scoped to the clicked category) was confirmed interactively in Phase 1. **Add Category / UpLoad File** not exercised.

## WF-18 — Profile / contact info update

Already documented at PL-03. Fields: First name, Last name, Cell Phone, Home Phone, Pager, "Calendar days to keep" (numeric), **Update Contact Info** button — not exercised.

## WF-19 — Change password (self-service, authenticated)

- **Starting screen:** PL-03 (`/users/profile`)
- **Fields [OBSERVED]:** Current Password, New Password, Re-type New Password, **Change password** button.
- **Validation:** not observed (not submitted); a mismatch check between New/Re-type is the only plausible client-side rule, unconfirmed.
- Distinct from WF-02 (unauthenticated recovery), which remains unobserved.

## WF-20 — Default group selection

- **Starting screen:** PL-03, below Change Password
- **Fields [OBSERVED]:** a radio choice between the account's groups (e.g. the two Trillium sites) + **Save Default Group** button.
- **Distinction from WF-03:** this is the **persisted** default used at next login; WF-03's top-bar switcher is a live, session-only override. Not exercised.

## WF-21 — Notification escalation configuration

Already documented at PL-02. No new fields found this phase; confirmed the "Select Proxy User" and per-step channel toggles are the only interactive elements, all left untouched.

## WF-22 — Pick proxy delegation

- Sub-workflow of PL-02: **Pick Proxy** On/Off toggle (observed Off, default for this account) + **"Select Proxy User"** combobox + **Save Proxy** button.
- The combobox is a custom widget (confirmed via DOM inspection — no native `<select>` present) whose option list only populates on interaction; it was **deliberately not opened**, both to avoid an accidental selection so close to a save-capable control, and to avoid capturing an unnecessary personal-name list per RESEARCH-RULES data-handling guidance.
- **Unanswered questions:** eligible-proxy scope (same group? same role? unrestricted?) — **[UNRESOLVED]**, see 02-role-permission-matrix.md unresolved item #27.

## WF-23 — Calendar subscription (iCal)

- **Actor:** any user, own schedule only
- **Starting screen:** My Schedule, **Subscribe** button
- **Navigation sequence [OBSERVED]:** click Subscribe → **"Subscribe To Calendar"** modal opens with explanatory copy ("Clicking on the link below will connect your iCal to ischedule.MD. This only works for Mac/iPhone. For other calendars, copy and paste the link below.") and a single **webcal://** link.
- **Link structure [OBSERVED, value redacted]:** `webcal://ischedule.md/users/ical?email=<url-encoded-own-email>&groupId=<N>&hash=<long opaque token>`. The `hash` parameter is a bearer-style authentication token that lets any calendar client pull the user's personal schedule without further login. **This token is not reproduced anywhere in this report or its evidence files**, per RESEARCH-RULES' prohibition on capturing credentials/tokens.
- **Security-relevant observation:** this is a long-lived, unauthenticated (no password re-entry) feed URL containing PII (the user's own email) and a persistent secret token, generated on-demand every time Subscribe is clicked (**[UNRESOLVED]** whether it's a stable per-user token or freshly minted per click — would need two separate captures to compare, not done to avoid retaining the token anywhere even transiently for comparison). Any clean-room design should treat calendar-feed tokens as sensitive, ideally revocable/rotatable independent of the user's login password.
- Dismissed via **Close**.
- **Evidence:** SCH-01

---

## Master checklist — Phase 4 topics

| Topic | Status |
|---|---|
| Login | **[UNRESOLVED]** — not observed; deliberately not tested (no recovery credentials) |
| Password reset | **[UNRESOLVED]** — same reason |
| Group switching | **[OBSERVED]** — WF-03 |
| Personal schedule | **[OBSERVED]** — WF-04 |
| Organization schedule | **[OBSERVED]** — WF-05 |
| Date/range navigation | **[OBSERVED]** — WF-06 |
| Shift details | **[OBSERVED]** — WF-07 |
| ON/OFF requests | **[OBSERVED]** creation+withdrawal for vacation-type; **[UNRESOLVED]** for shift-group-scoped "OFF {X}" requests — WF-08/09/10 |
| Request status | **[OBSERVED]** — WF-10 |
| Opportunities/give-away | **[OBSERVED]** creation trigger + retraction; **[UNRESOLVED]** the claim side — WF-11/12 |
| Shift swaps | **[OBSERVED]** form structure; **[UNRESOLVED]** approval/acceptance model — WF-13 |
| On-call assignments | **[OBSERVED]** — WF-14 |
| Daily assignments | **[OBSERVED]** — WF-15 |
| Contacts | **[OBSERVED]** — WF-16 |
| Documents | **[OBSERVED]** — WF-17 |
| Profiles | **[OBSERVED]** — WF-18/19/20 |
| Notification preferences | **[OBSERVED]** — WF-21 |
| Proxies | **[OBSERVED]** structure; **[UNRESOLVED]** eligibility scope — WF-22 |
| Calendar subscriptions | **[OBSERVED]** — WF-23 (token redacted) |

---

## Safety & boundary notes for this phase

- No form was submitted: Swap Shifts, Vacation Block Selection's Confirm/Remove/Deny/Save Comment, POST OPPORTUNITY, Opportunity Board's Remove, Change password, Update Contact Info, Save Default Group, Save (notifications), Save Proxy — none were clicked.
- A second browser tab was opened solely to test whether "Sign In" from the marketing homepage would reveal a login form while the primary session remained authenticated; it did not (redirected straight into the app), confirming shared session state; the tab was closed immediately after.
- The account was **never signed out**, to preserve continued access for Phases 5–7.
- The "Staff for swap" and "Select Proxy User" comboboxes were left unopened (custom widgets, no native `<select>` to inspect risk-free).
- The calendar-subscription token was viewed on-screen and its *structure* described, but the token value itself was not copied into any file, variable, or intermediate note.

## Evidence & follow-up

- Screenshots not yet exported to disk (standing limitation, same as Phases 1 and 3).
- New workflow IDs (WF-01…23) added to [source-page-index.md](source-page-index.md).
- Unresolved items merged into [unresolved-questions.md](unresolved-questions.md).
- This report logged in [evidence-register.md](evidence-register.md).
