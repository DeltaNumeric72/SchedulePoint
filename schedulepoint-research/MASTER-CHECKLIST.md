# SchedulePoint Research — Master Checklist

High-level tracker for the overall research effort. Check items off as they're completed; link to detailed evidence rather than duplicating it here.

## Setup

- [x] Workspace directory structure created
- [x] `reports/manifest.json` created
- [x] `reports/source-page-index.md` created
- [x] `reports/evidence-register.md` created
- [x] `reports/unresolved-questions.md` created
- [x] `reports/inbox/` created for untriaged notes
- [x] Validation script in place (`validate.sh`)
- [x] `RESEARCH-RULES.md` created — read-only navigation rules and mutation prohibitions for Claude for Chrome

## Area coverage

- [x] Navigation — top-level menus and routing mapped ([source-page-index.md](reports/source-page-index.md)); see [01-application-map.md](reports/01-application-map.md)
- [x] Schedule — My Schedule, Master Schedule (3 view modes), On Call, Daily Assignments documented
- [ ] Requests — partially documented (surfaced in My Schedule / Master Schedule tooltips / Shift Groups); submission form itself not yet located — see unresolved-questions.md #16
- [x] Vacation — grid + settings documented; TRANSFER/Batch Entry Off not exercised (mutating)
- [x] Picklist — Choose List, Notification Settings, Picklist Manager, Dashboard documented; no active picklist observed live
- [x] Admin — Group Settings, Builds, Staff Shift FTE, Statistics, Staff/Users, Staff Groups, Shifts, Shift Groups, Valid Groups (partial), Pattern Rules, **Staff Rules** documented
- [ ] Errors — not yet specifically catalogued (no error states encountered this pass)
- [x] **Roles/permissions (Phase 3)** — 6 Access Levels confirmed (Staff, Locum, View, Telecom, Scheduler, Genius); role-permission matrix built; role confirmed scoped per-group-membership, not global. See [02-role-permission-matrix.md](reports/02-role-permission-matrix.md). Lower-privileged-role views remain unverified (no test account).
- [x] **Group/site switching (Phase 3)** — cross-group comparison done (independent rosters, independent request-window state, same Access Level held by reviewing account in both groups)
- [ ] **Department** — searched, not found as a distinct entity (only a Documents folder label); see unresolved-questions.md #25
- [x] **Phase 4: User-facing workflows** — 23 workflows (WF-01..23) documented in [03-user-workflows.md](reports/03-user-workflows.md): request creation/withdrawal, opportunities, swaps, on-call, contacts, documents, profile, notifications, proxy, calendar subscription. Login/password-reset deliberately left unobserved (no recovery credentials). Major find: per-cell audit/provenance log on Master Schedule.
- [x] **Phase 5: Master schedule deep dive** — documented in [04-master-schedule.md](reports/04-master-schedule.md): 3 views, cell editor internals, Shifts/Credits independent-movement split, full audit-log evidence, Given/When/Then acceptance criteria for confirmed draft/lock behaviour. Draft/publish mechanics substantially deferred to Build-level evidence (no explicit toggle on Master Schedule itself).
- [x] **Phase 6: Scheduling engine/config** — documented in [05-scheduling-engine.md](reports/05-scheduling-engine.md): full authoring-form field inventory for Build Setup, Pattern Rule Setup, Staff Rule Setup, Valid Group Setup, and the "Pick Shifts" position-count constraint. Resolves Phase 1's open Valid Groups question. No configuration saved, no build stage invoked.
- [x] **Phase 7: Requests/vacation/opportunities/swaps lifecycle** — documented in [06-requests-vacation-opportunities.md](reports/06-requests-vacation-opportunities.md): 5 lifecycles (LC-01..05) with Mermaid state diagrams and Given/When/Then criteria. Major finding: irreversible, type-to-confirm ("PUBLISH") Vacation→Master Schedule transfer — the highest-consequence single control found in the whole product. Standing gap: shift-group-scoped "OFF {X}" request creation surface still not located.

## Evidence hygiene

- [ ] All screenshots use generic filenames (no names, phone numbers, patient details)
- [ ] Redaction checklist applied to every screenshot ([evidence-register.md](reports/evidence-register.md))
- [ ] Evidence register cross-referenced against source page index

## Wrap-up

- [ ] All entries in [unresolved-questions.md](reports/unresolved-questions.md) resolved or explicitly deferred
- [ ] Final report drafted from `reports/` contents
- [ ] Validation script passes with no missing/empty required files

## Notes

Add dated notes here as the research progresses. Keep sensitive details out of this file — use generic descriptions only.

- **2026-07-30** — Phase 1 clean-room read-only exploration of ischedule.md completed; 29 screens/areas documented in [01-application-map.md](reports/01-application-map.md). No mutating actions were performed. One near-miss recorded: a Vacation-grid badge click opened a delete-confirmation modal by default (dismissed via Cancel) — flagged as a UX pattern to avoid in SchedulePoint. Screenshot capture to disk is still outstanding (logical `screenshot_ref` placeholders only) — next pass should export actual PNGs into `screenshots/<area>/` using generic filenames.
- **2026-07-30** — Phase 3 role/permission audit completed; [02-role-permission-matrix.md](reports/02-role-permission-matrix.md) written, merging by stable ID into Phase 1 rather than duplicating. Found a missed 11th Scheduling sub-item ("Staff Rules," ADM-11) via a DOM sweep, inspected the "Sign In As" impersonation form (SYS-05) without submitting it, and — most significantly — established via cross-group roster comparison that (a) there are 6 Access Levels, not 3 (Staff, Locum, View, Telecom, Scheduler, Genius), and (b) a person's role is scoped per group membership, not a single global account property. No mutating actions were performed (no approve/publish/delete/save/impersonate). "Department" was searched for and confirmed absent as a distinct entity.
