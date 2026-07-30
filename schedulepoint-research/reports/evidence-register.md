# Evidence Register

Chronological log of every piece of evidence (screenshot or artifact) collected during research. Each entry must use a generic filename with no names, phone numbers, patient details, or other sensitive data.

| Date | Filename | Folder | Area | Description | Related Page Index # | Collected By |
|------|----------|--------|------|-------------|------------------------|---------------|
| 2026-07-30 | 01-application-map.md | reports/ | all | Text-evidence artifact: full Phase 1 application map of ischedule.md (screen inventory, role model, domain glossary, master checklist). No screenshots were exported to disk this pass — see unresolved-questions.md #s covering follow-up capture. | 1-29 | Claude (read-only browser session) |
| 2026-07-30 | 02-role-permission-matrix.md | reports/ | admin / roles | Text-evidence artifact: Phase 3 role/account/group/permission audit. Corrects Phase 1 (11th Scheduling sub-item "Staff Rules" found; Access Level enumeration expanded from 3 to 6 values: Staff, Locum, View, Telecom, Scheduler, Genius; established role is scoped per-group-membership via cross-group roster comparison). No screenshots exported to disk this pass. No real names/emails/phones reproduced — cross-group examples anonymized. | 30-33 | Claude (read-only browser session) |
| 2026-07-30 | 03-user-workflows.md | reports/ | requests / schedule / picklist | Text-evidence artifact: Phase 4 user-facing workflow audit (WF-01..23). Located the vacation/OFF request creation form (Vacation grid empty-cell click) and withdrawal form (existing-badge click), the Opportunity Board post/remove mechanism, Swap Shift modal, and — most significantly — a per-cell change-provenance audit log on the Master Schedule. Login/password-reset deliberately left unobserved (would require signing out with no recovery credentials). Calendar-subscription token structure documented; token value itself not captured. No PII reproduced. | 34-44 | Claude (read-only browser session) |
| 2026-07-30 | 04-master-schedule.md | reports/ | schedule | Text-evidence artifact: Phase 5 Master Schedule deep dive. Major finding: cell editor's "Display" selector splits Shifts vs. Credits into independently-movable values per cell, explaining the Credits/Actual-Shifts distinction seen in Shift Statistics. Full 30-code shift legend captured (generic, non-sensitive). Draft/publish/lock behaviour substantially deferred to Build-level evidence (05-scheduling-engine.md) since Master Schedule itself exposes no explicit draft/publish toggle. Given/When/Then acceptance criteria included for confirmed behaviours. No mutating action taken; no real names reproduced (audit-log examples anonymized). | 45-47 | Claude (read-only browser session) |
| 2026-07-30 | 05-scheduling-engine.md | reports/ | admin | Text-evidence artifact: Phase 6 scheduling-configuration/engine audit. Full field inventory for Build Setup (Progressive Build chaining, solver toggles, chip-list scoping), Pattern Rule Setup and Staff Rule Setup authoring forms (resolves Hard vs. Weight Penalty and Offset vs. Optimal Spacing terminology; reveals a richer 5-action Staff Rule THEN clause than any existing rule uses), Valid Group Setup (resolves a Phase 1 open question — restricts shift codes to specific pick-order positions), and the "Pick Shifts" number-of-positions constraint (group-wide, increase-only). No configuration saved; no chip added/removed in any list. | 48-52 | Claude (read-only browser session) |
| 2026-07-30 | 06-requests-vacation-opportunities.md | reports/ | vacation / requests | Text-evidence artifact: Phase 7 lifecycle audit (LC-01..05) with Mermaid state diagrams and Given/When/Then acceptance criteria. Major finding: the Vacation module's "TRANSFER" button opens a "TRANSFER VACATIONS TO MASTER SCHEDULE" dialog requiring the literal word "PUBLISH" to be typed as confirmation, explicitly labeled irreversible — the highest-consequence single control found across all seven phases. Also found the Batch Approval (date-range) tool. Neither was submitted. Confirmed a graduated confirmation-friction pattern scaling with each action's blast radius. Remaining gap: creation surface for shift-group-scoped "OFF {X}" requests not located despite thorough search. No PII reproduced. | 53-56 | Claude (read-only browser session) |
| 2026-07-30 | 07-picklist-system.md | reports/ | picklist | Text-evidence artifact: Phase 8 picklist system audit (preparation, execution, notifications, real-time, completion/correction) with Mermaid state diagrams and Given/When/Then criteria. **Contains a documented safety incident (§0):** an "Add Room" control on an ON HOLD picklist created a real room immediately on click with no preview/confirm step, contrary to every other "Add" control's behavior observed in 7 prior phases; the room was identified and deleted within the same tool-call sequence, verified back to its exact prior count (18). Resolved that Picklist Manager's "Import" buttons are erase-and-resync confirmations, not file uploads — the actual OR-slate file-import mechanism (if any) remains unlocated. No active/live picklist was available at any point across all 8 phases, so execution-phase and real-time/concurrency behavior is substantially inferred rather than observed — flagged as the largest remaining evidence gap in the full research effort. No PHI, credentials, or unnecessary personal data captured. | 57-61 | Claude (read-only browser session) |
| 2026-07-30 | 08-supporting-modules.md | reports/ | navigation / admin | Text-evidence artifact: Phase 9 supporting-modules audit (reports/statistics, contacts/messaging, documents, help/support/integrations), executed entirely under the strengthened post-incident safety boundary — evidence gathered via DOM/href/computed-style inspection rather than clicking any Add/New/Create/Import/Save/Send/etc.-associated control. Resolved: Vacation's "Help" button is an unimplemented `/Help/ComingSoon.pdf` stub; Print/Share controls on 4 screens catalogued but not activated; Stipend confirmed as an export-type only, no dedicated screen exists. Left explicitly UNRESOLVED per protocol: Contacts row-click behavior (cursor:pointer observed, not clicked). One no-op click (Help link, no URL change) recorded as a non-incident. No PHI, credentials, tokens, or document contents captured; one JS query was auto-blocked for cookie/query-string-shaped content and immediately narrowed rather than retried. | 62-66 | Claude (read-only browser session) |

## Filename convention

`<area>-<screen-or-state>-<sequence>.png`

Examples:
- `navigation-main-menu-01.png`
- `schedule-week-view-01.png`
- `requests-submit-form-01.png`
- `requests-submit-error-01.png`
- `vacation-request-list-01.png`
- `picklist-shift-bid-01.png`
- `admin-user-settings-01.png`
- `errors-session-timeout-01.png`

## Redaction checklist (apply before saving any screenshot)

- [ ] No personal names visible
- [ ] No phone numbers visible
- [ ] No patient/client details visible
- [ ] No employee ID numbers or badge numbers visible
- [ ] No email addresses visible
- [ ] No account numbers, tokens, or credentials visible
- [ ] Any unavoidable sensitive field is blurred/blacked out before the file is saved
