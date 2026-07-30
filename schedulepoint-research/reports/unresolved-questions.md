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

## Status values

- `open` — no answer yet
- `investigating` — actively being looked into
- `answered` — resolved, answer recorded in this table
- `blocked` — cannot proceed without external input

## How to add a question

1. Assign the next sequential `#`.
2. Keep the question generic — do not embed names, phone numbers, or patient details in the question text.
3. Link to relevant evidence in [evidence-register.md](evidence-register.md) or page entries in [source-page-index.md](source-page-index.md) if applicable.
