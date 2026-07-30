# Unresolved Questions

Open questions discovered during research that need follow-up, clarification from a stakeholder, or further investigation before the corresponding report section can be finalized.

| # | Question | Area | Raised On | Status | Answer / Resolution |
|---|----------|------|-----------|--------|----------------------|
| 1 | Does a plain "Staff" role see the same top bar/sidebar (Dashboard, Sign In As, Scheduling admin accordion) as a Scheduler-level account? | navigation / roles | 2026-07-30 | open | Requires a second session signed in as a Staff-level account |
| 2 | What does "Swap Shift" (My Schedule) open, and who can it target? | schedule / requests | 2026-07-30 | open | Not clicked to stay read-only about submission flows |
| 3 | Who can see/claim Opportunity Board entries — anyone, or only shift-group-eligible staff? | schedule / opportunities | 2026-07-30 | open | |
| 4 | Exact "Staff Balance" formula beyond Staff Available − Daily Picks − Operating Rooms | schedule | 2026-07-30 | open | |
| 5 | Does "Batch Add/Delete" on Master Schedule write directly to the live schedule or to a draft/Build? | schedule / admin | 2026-07-30 | open | |
| 6 | What do the amber vs. green vacation status badges mean precisely (pending vs. approved vs. conflict)? | vacation | 2026-07-30 | open | |
| 7 | What does Vacation's "TRANSFER" button do (reassign a vacation slot to another staff member)? | vacation | 2026-07-30 | open | Not clicked — mutating |
| 8 | What does "Batch Entry Off" do on the Vacation screen? | vacation | 2026-07-30 | open | Not clicked — mutating |
| 9 | Exact meaning of the numeric badge per Daily Assignments work line (case count?) | schedule | 2026-07-30 | open | |
| 10 | What does an *active* (in-progress) picklist look like on Choose List / Picklist Manager / Dashboard? | picklist | 2026-07-30 | open | None were active during the review session |
| 11 | What do "Proxy Locked" / "Notification Locked" (Users admin table) do to a user's Notification Settings screen? | notifications / admin | 2026-07-30 | open | |
| 12 | Purpose of "Report Box" field on Group Settings | admin | 2026-07-30 | open | |
| 13 | What exactly do Setup / Planner / Build / Fix Picks / Publish do in the Builds pipeline? | admin / builds | 2026-07-30 | open | Not clicked — high blast radius, includes "Erase Master Schedule" |
| 14 | Meaning of "Action Time" column on Staff (Users) admin table | admin / roles | 2026-07-30 | open | Possibly a per-user pick-turn time limit in seconds |
| 15 | Purpose/schema of "Valid Groups" beyond the list of names | admin | 2026-07-30 | answered | Resolved in Phase 6 (05-scheduling-engine.md §"ADM-09"): "Group One" = shift codes, "Group Two" = pick-order positions; restricts which draft positions are legal for a given shift set. Observed instance was unrestricted (all 30 positions); restrictive case inferred but not directly observed |
| 16 | Where does a staff member actually submit a *new* request (the request submission form itself was not located)? | requests | 2026-07-30 | open | |
| 17 | Is the app's mobile story a responsive web layout, or purely phone-channel (SMS/voice) picking? | mobile | 2026-07-30 | open | Window-resize test was inconclusive this pass |
| 18 | Does "Tour" trigger differently depending on screen or first-login state? | navigation | 2026-07-30 | open | Did not visibly launch on repeated click |
| 19 | Does a Staff/Locum/View/Telecom-level session see a smaller sidebar than the Scheduler-level session used throughout this review? | roles | 2026-07-30 | open | Requires a different-role test account; impersonation is prohibited |
| 20 | What does "Picklist Admin: Yes" grant beyond ordinary Scheduler access? | roles / admin | 2026-07-30 | open | A Picklist-Admin=No Scheduler account already had full Picklist Manager access |
| 21 | What does "Admin Emails: Yes" actually deliver? | roles / notifications | 2026-07-30 | open | |
| 22 | Does "Genius" carry any capability beyond "Scheduler"? | roles | 2026-07-30 | open | No Genius-level session was available; no capability gap found in this review |
| 23 | Is the vendor-domain "Super"-named account (Access Level shown as ordinary Scheduler) a genuine elevated backdoor or an ordinary-privilege support login? | security / roles | 2026-07-30 | open | Cannot be confirmed from the UI alone |
| 24 | Does impersonation (Sign In As) assume the impersonated user's permissions, or retain the impersonator's own? | security / roles | 2026-07-30 | open | Sign In As form was loaded but never submitted (prohibited) |
| 25 | Is there a true "Department" concept anywhere in the product? | data model | 2026-07-30 | answered | Searched Group Settings, Staff Groups, Shift Groups, Users, sidebar — none found. Only appearance is a Documents folder named "Department" (not an org unit) |
| 26 | What determines whether a Locum-role row has "Show In Grid: Yes" vs "No"? | roles / admin | 2026-07-30 | open | Manual per-row toggle vs. derived from current assignments — unclear |
| 27 | Who is eligible to be selected as a "Pick Proxy" (same group only? same role? unrestricted)? | notifications / proxy | 2026-07-30 | open | Combobox option list was not enumerated (custom widget; avoided to prevent unnecessary PII capture and accidental selection) |
| 28 | Does a lower-privileged account see both of its groups in the site switcher, or only operate in one at a time? | roles / group-switching | 2026-07-30 | open | |
| 29 | What do the actual login form and password-reset flow look like (fields, MFA, lockout)? | auth | 2026-07-30 | open | Deliberately not observed — would require signing out with no recovery credentials available |
| 30 | Where are shift-group-scoped "OFF {X}" requests (e.g. "OFF {All Call}") created, if not via the Vacation grid's week-cell click? | requests | 2026-07-30 | open | Searched My Schedule and Vacation thoroughly; not located |
| 31 | Do the My Requests panel's per-row DELETE and the Vacation grid's badge-click Remove act on the same underlying record for vacation-type requests? | requests | 2026-07-30 | open | |
| 32 | Does Shift Swap require the proposed partner's acceptance, or is it Scheduler-approved unilaterally like vacation? | requests / swaps | 2026-07-30 | open | No equivalent "Approval Required" setting found for swaps specifically |
| 33 | Does posting to the Opportunity Board or proposing a Swap trigger a notification to other staff? | requests / notifications | 2026-07-30 | open | |
| 34 | Is the Master Schedule cell audit log (WF-05a) visible to staff for their own cells, or admin-only? Is it exhaustive of all change types? | schedule / audit | 2026-07-30 | open | Major new finding this phase; not cross-checked against a non-own row |
| 35 | Is the calendar-subscription `hash` token stable per user, or freshly minted each time Subscribe is clicked? | integrations / security | 2026-07-30 | open | Not compared across two captures, to avoid retaining the token even transiently |
| 36 | Does the Master Schedule cell-editor audit log capture literally every change type (e.g. Build Publish, Erase Master Schedule), or only cell-level moves/reassignments? | schedule / audit | 2026-07-30 | open | Phase 5 |
| 37 | Can staff view the cell audit log for their own cells unassisted, or is the cell editor admin/Scheduler-only? | schedule / roles | 2026-07-30 | open | Only tested with a Scheduler-level session |
| 38 | Once a Build is Locked, are direct Master Schedule cell edits also blocked, or only the Build pipeline's own Setup/Planner/Fix Picks/Publish controls? | schedule / builds | 2026-07-30 | open | Deliberately not tested — would require attempting an edit on a locked period |
| 39 | What does the "Calendar events" row on Master Schedule show when populated? | schedule | 2026-07-30 | open | No populated example encountered in date ranges browsed |
| 40 | Is there any explicit rollback/unpublish control anywhere, or is Build Unlock the closest equivalent (and does it reverse the lock only, or the published content too)? | schedule / builds | 2026-07-30 | open | No such control found in any phase so far |
| 41 | What does the "Planner" stage screen actually show/let you do? | admin / builds | 2026-07-30 | open | Clicking Planner produced no visible navigation in this session; not forced via Save & Generate Planner |
| 42 | Does the engine automatically exclude vacationed/OFF staff from a build, or is this an implicit assumption not directly confirmed? | admin / builds | 2026-07-30 | open | No explicit toggle found on Build Setup |
| 43 | What happens on build failure — is there a distinct error/failed state, and does regeneration follow a specific review workflow? | admin / builds | 2026-07-30 | open | No failure state encountered; inferred from the "Step 1/2/3/4" naming convention and Progressive Build chaining |
| 44 | Beyond the one observed (unrestricted) example, what does a restrictive Valid Group actually block in practice? | admin | 2026-07-30 | open | Phase 6; only one Valid Group's content was inspected |
| 45 | Is the Vacation "TRANSFER" (publish to Master Schedule) operation idempotent, and can it be scoped narrower than the full active block? | vacation | 2026-07-30 | open | Phase 7; not exercised — explicitly irreversible per its own confirmation text |
| 46 | What does the Batch Entry Off / Batch Entry On form actually contain? | vacation | 2026-07-30 | open | Phase 7; only opened to menu-label level |
| 47 | Where is a shift-group-scoped "OFF {X}" request actually created (distinct from the vacation-block week-cell click)? | requests | 2026-07-30 | open | Phase 7; standing gap after 4 phases of otherwise-thorough coverage — see 06-requests-vacation-opportunities.md LC-02 |
| 48 | Does Shift Swap require partner acceptance, Scheduler approval, both, or neither? | requests / swaps | 2026-07-30 | open | Phase 7; form opened, not submitted; no swap-shaped entry seen in request history |
| 49 | What resolves a race if two staff attempt to claim the same posted Opportunity simultaneously? | requests / opportunities | 2026-07-30 | open | Phase 7; claim side never observed (single-account research limitation) |
| 50 | Does the vacation-approval or opportunity/swap lifecycle send any notification (email/SMS/push)? | notifications | 2026-07-30 | open | Phase 7; no explicit toggle found for these specific events |
| 51 | What does live picklist execution actually look like (current picker, timer, room-selection UI, confirmation, failure/retry)? | picklist | 2026-07-30 | open | Phase 8; no active picklist was available across any of the 8 phases — the single largest remaining gap in this research effort |
| 52 | Where/how is external OR/case-slate data actually ingested, if not via the Picklist Manager Import buttons (confirmed to be erase-and-resync, not file upload)? | picklist / integrations | 2026-07-30 | open | Phase 8; Group Settings' "ImportStrip" field is the only remaining hint that a file-based import exists somewhere |
| 53 | Does the picklist notification system have any observable delivery-status, failure, retry, or duplicate-protection behavior? | notifications / picklist | 2026-07-30 | open | Phase 8; no delivery log or status indicator found anywhere in the product |
| 54 | Does the "Locked→Unlock" toggle on a COMPLETED picklist actually reopen it for editing, and what happens to already-distributed final assignments if so? | picklist | 2026-07-30 | open | Phase 8; not tested — explicitly prohibited ("never reopen a picklist") |
| 55 | Do other "Add"/"New" controls elsewhere in the product also commit instantly like the picklist's "Add Room" (§0 incident), or was that control specifically anomalous? | product-wide / UX safety | 2026-07-30 | open | Phase 8; discovered via an actual incident — every other "Add" control encountered in phases 1-7 was assumed (not proven) to stage a draft before commit |
| 56 | What do the two PDF files in the "ischedule documents" category (scheduling/shift-change guidance) actually say? | picklist / documents | 2026-07-30 | open | Phase 8; seen listed, not opened — downloading requires explicit permission not sought this session |
| 57 | What do the Master Schedule Print-menu's Schedule/Picklist/Stipend/Requests options actually produce (format, preview step, one-time side effects)? | reports | 2026-07-30 | investigating | Phase 9 found all four are `href="#"` JS-driven controls, none clicked. Phase 10 resolved via passive heading-text inspection (no click) that each opens a "Create `<Type>` Report" dialog (a 5th type, "DayXShift Report," also found) — so a configuration step exists before output, not an instant download. Still open: the dialogs' actual fields and output format. Future test: open (don't submit) each "Create X Report" dialog in an explicitly-authorized session |
| 58 | What do On Call's and Shift Statistics' Print/Share buttons actually do? | reports | 2026-07-30 | open | Phase 9; same reasoning as #57 |
| 59 | What happens when a Contacts row is clicked? | navigation | 2026-07-30 | open | Phase 9; cursor:pointer observed via computed style, deliberately left untested per the strengthened safety boundary. Future test: click exactly one row in an authorized session and observe |
| 60 | Why does the Contacts screen show 66 rows vs. the Users/Staff admin table's 94 rows for the same group? | navigation / roles | 2026-07-30 | open | Phase 9; suggests Contacts applies its own filter (e.g. excludes View/Telecom functional accounts) — exact rule unconfirmed |
| 61 | Do other Help buttons exist elsewhere in the product, and if so do they point to the same ComingSoon.pdf stub or different content? | navigation | 2026-07-30 | open | Phase 9; only one Help button (Vacation) was ever noticed across all 9 phases |
| 61a | Why does the "Tour" nav link never visibly fire despite `bootstraptour` being loaded as a script on every page? | technical / navigation | 2026-07-30 | open | Phase 11 confirmed the library loads on every page load (no 404, no console error); Phase 1/9 confirmed the link produces no visible effect on click. Likely a silent no-op (e.g. a first-login-only flag not set), not a crash |
| 62 | What are the composition fields, templates, attachment options, and validation for Contacts' Send Email / Send SMS bulk actions? | messaging | 2026-07-30 | open | Phase 9; forms never opened — both are explicitly prohibited click targets |
| 63 | Does any element anywhere in the app show a visible keyboard-focus indicator? | accessibility | 2026-07-30 | open | Phase 10; `outline:none` confirmed on every sampled focus stop (sidebar toggle, nav link) with no alternative found; only a handful of stops sampled, not exhaustive |
| 64 | What do the two unlabeled non-Prev/Next buttons found in the accessible-name scan actually do (dropdown-toggle near "Save Changes")? | accessibility | 2026-07-30 | open | Phase 10; identified via DOM query only, not clicked |
| 65 | What is the exact CSS breakpoint at which the sidebar collapses to a hamburger menu? | responsive | 2026-07-30 | open | Phase 10; only bracketed between 768px and 1512px |
| 66 | Does the horizontal-overflow-at-phone-width pattern found on Contacts also affect the other admin data tables (Staff/Users, Builds, Pattern/Staff Rules, Shifts)? | responsive | 2026-07-30 | open | Phase 10; inferred by pattern similarity, not independently re-tested on each screen |
| 67 | What do the 4 aria-live regions on Master Schedule actually announce, and when? | accessibility | 2026-07-30 | open | Phase 10; existence confirmed via DOM query, purpose not individually inspected |
| 68 | Which of the 3 images on Master Schedule lacks alt text, and is it decorative or informational? | accessibility | 2026-07-30 | open | Phase 10; count confirmed via DOM query, not individually identified |
| 69 | What is the required-field indication and error-message exposure pattern on ischedule.md forms? | accessibility | 2026-07-30 | open | Phase 10; no form was submitted across any phase, so no validation/error state was ever observed |
| 70 | How does the app behave under browser zoom (as opposed to viewport resize)? | accessibility | 2026-07-30 | open | Phase 10; not tested — inferred favorable from fluid calendar layout, not directly confirmed |
| 71 | What is the response envelope/body shape for any `/api/*` endpoint (pagination metadata, error structure, etc.)? | technical | 2026-07-30 | open | Phase 11; no response body was fetched — only request URL patterns observed |
| 72 | What actual message payloads flow through the SignalR "picklist" hub during a real draft? | technical / picklist | 2026-07-30 | open | Phase 11; hub confirmed to exist and connect on every page load, but no picklist was ever active to observe message content — deliberately not pursued per this phase's instructions |
| 73 | Is WebSocket transport available server-side at all, or does SignalR only ever offer long-polling for this deployment? | technical | 2026-07-30 | open | Phase 11; transport negotiated to longPolling in every observed session; negotiation response body (which would list available transports) not inspected |
| 74 | What is the root cause of the `/api/pickordersadmin` duplicate-request burst (~25-40x per click)? | technical / performance | 2026-07-30 | open | Phase 11; diagnosable only via DevTools initiator/call-stack inspection or source access, neither available |
| 75 | What is ischedule.md's session/idle-timeout duration? | technical / auth | 2026-07-30 | open | Phase 11; session persisted across the entire multi-hour, multi-phase research effort with no observed expiry |
| 76 | Does ischedule.md use an anti-forgery token, and if so what mechanism/name? | technical / security | 2026-07-30 | open | Phase 11; no POST/PUT/DELETE request was ever triggered to observe one |
| 77 | Why does three different date-serialization formats coexist across sibling `/api/*` endpoints — is this consistent in responses too? | technical | 2026-07-30 | open | Phase 11; ISO YYYY-MM-DD, US MM/DD/YYYY, and "MMM D, YYYY" all observed across different endpoints in the same session |
| 78 | What is the exact purpose/schema of the "jobs" API resource (`/api/jobs`, `/api/jobs/JobsForRequest`)? | technical | 2026-07-30 | open | Phase 11; name and call sites observed, payload/purpose inferred only |

## Phase 12 disposition (2026-07-30)

Phase 12 created no new source-site questions — it performed no ischedule.md navigation. Instead it **carried existing open questions forward as SchedulePoint test requirements** rather than closing them. The mapping is recorded in [11-edge-cases-and-qa.md](11-edge-cases-and-qa.md) §16.

Questions carried forward with a named SchedulePoint test: #20 (Picklist Admin flag vs. actual capability → QA-AUTH-007, contradiction C-02), #31 (two withdrawal surfaces → QA-REQ-006/011, C-03), #35 (calendar-feed token strength → QA-SEC-009), #51 (picklist turn timers → QA-A11Y-014, QA-PICK-006), #60 (Contacts vs. Users roster discrepancy → QA-SEC-014, C-06), #62 (bulk-messaging composition → QA-SEC-013), #63 (focus styling → QA-A11Y-001), #64 (icon-button names → QA-A11Y-002), #65 (exact responsive breakpoint → QA-A11Y-016), #66 (Contacts overflow → QA-A11Y-015), #67 (aria-live purpose → QA-A11Y-013), #69 (validation/error presentation → QA-A11Y-004/005), #70 (zoom/reflow → QA-A11Y-016), #72 (SignalR payloads → QA-PICK-012, C-04), #73 (transport availability → QA-PERF-006/011, C-04), #74 (duplicate-request root cause → QA-PERF-001..004), #75 (session timeout → QA-AUTH-001/002), #76 (anti-forgery mechanism → QA-AUTH-012), #77 (date-format inconsistency → QA-DATE-001).

Explicitly **not** carried forward: the two unopened PDF documents in the documents library (never opened by instruction in every phase, and no SchedulePoint requirement derives from their contents) and the tour-library behaviour (#loaded-but-never-fired; no requirement derives from it).

**Status of all remaining questions: open against ischedule.md, permanently.** Broad research against the source site is closed after Phase 12. Any future source-site interaction requires a specific, separately-authorized comparison need.

## Status values

- `open` — no answer yet
- `investigating` — actively being looked into
- `answered` — resolved, answer recorded in this table
- `blocked` — cannot proceed without external input

## How to add a question

1. Assign the next sequential `#`.
2. Keep the question generic — do not embed names, phone numbers, or patient details in the question text.
3. Link to relevant evidence in [evidence-register.md](evidence-register.md) or page entries in [source-page-index.md](source-page-index.md) if applicable.
