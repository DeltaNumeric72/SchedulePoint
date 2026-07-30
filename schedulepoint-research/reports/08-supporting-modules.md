# 08 — Supporting Modules & Remaining Coverage Gaps: ischedule.MD

**Phase:** 9 — reports/statistics, contacts/messaging, documents, profile/notifications/defaults/help/integrations, and any remaining unclassified surfaces.

**Method:** Read-only per [RESEARCH-RULES.md](../RESEARCH-RULES.md), under the **strengthened safety boundary** issued for this batch following the Phase 8 "Add Room" incident. Per that boundary: no control was clicked whose effect was not already definitively established as read-only by a prior phase, and no control associated with any of the listed action verbs (Add/New/Create/Import/Sync/Upload/Download/Delete/Remove/Save/Submit/Apply/Publish/Approve/Accept/Reject/Withdraw/Transfer/Claim/Assign/Send/Share/Email/SMS/Notify/Start/Stop/Pause/Resume/Complete/Lock/Unlock/Confirm/Update/Edit/Impersonate/Sign in as) was clicked at all this phase. Evidence was gathered primarily by **reading the DOM/accessibility tree and element attributes** (via `read_page`, `find`, and narrowly-scoped read-only JavaScript inspection of tag/href/cursor-style, never full HTML dumps that could contain personal data) rather than by clicking speculative controls, consistent with "do not click controls merely to discover what they do."

**Merges by stable ID** into [01-application-map.md](01-application-map.md) (CON-01, DOC-01, PL-01/02/03, ADM-01, SYS-03/04) and [05-scheduling-engine.md](05-scheduling-engine.md) (ADM-04) rather than redescribing them; this report records deltas and newly-resolved/newly-flagged items only.

**Evidence labels:** **[OBSERVED]** · **[INFERRED]** · **[UNRESOLVED]**.

**No accidental mutation occurred this phase.** One click (on the Vacation page's "Help" button) registered on the page but produced no visible navigation or state change — the tab's URL remained unchanged. Inspecting the link's `href` afterward (read-only) showed it points to a static file path; see SM-01 below. This is recorded as a non-incident: no data was created, modified, or transmitted, and the click did not open, download, or render anything.

---

## SM-01 — Help ("Coming Soon" stub)

- **Screen:** Vacation (`/vacation/index`) top-right **Help** button
- **[OBSERVED, via `href` inspection, not by opening the file]:** the link's destination is `/Help/ComingSoon.pdf` — a literal placeholder filename indicating this specific Help entry point is an unimplemented stub in the live product, not real documentation.
- **Not opened/downloaded**, per this batch's strict "do not download or open" rule and the general PDF-avoidance practice from Phase 8.
- **Unresolved:** whether other Help buttons throughout the product (if any exist elsewhere) point to the same stub, to different stub files, or to real content. **Future test requirement:** inspect the `href` of every Help-labeled control found across the app (without opening any of them) and compare destinations.

## SM-02 — Print/Export/Share controls (existence catalogued, none activated)

Every report-adjacent screen found so far exposes a **Print** and/or **Share** button implemented as a plain `<button>` with **no `href`** (i.e., JavaScript-driven, not a simple link to a static resource) — meaning their effect (open a new tab? trigger a browser print dialog? generate and download a file? none of these could be distinguished without clicking, which was not done).

| Screen | Controls found | Evidence |
|---|---|---|
| Master Schedule (`/app/schedulenew`) | **Print ▾** dropdown containing 4 sub-items: **Schedule, Picklist, Stipend, Requests** — each an `<a href="#">`, confirming they are handled entirely by client-side script | [OBSERVED — dropdown menu opened to read labels only, no sub-item clicked] |
| On Call (`/app/oncalltoday`) | Two separate **Print** buttons (one per section: today's card, monthly grid) | [OBSERVED via DOM query] |
| Shift Statistics (`/admin/shiftstatistics`) | One **Print** button and one **Share** button | [OBSERVED via DOM query] |
| My Schedule (`/app`) | **Print** button (recap, Phase 1) | [OBSERVED, recap] |

**Data model implication:** the presence of a distinct **Stipend** print option on Master Schedule (alongside Schedule/Picklist/Requests) is the clearest evidence in this entire research effort that a **"Stipend report"** concept exists as a first-class export type, directly tied to the `Stipend` Yes/No flag on the Shifts catalog (ADM-07). No stand-alone "Stipend Report" screen was found anywhere in the sidebar or admin accordion — it appears to exist **only** as one of these four Print-menu export types, not as its own navigable page.

**Unresolved for every item above:** exact output format (PDF? in-browser print dialog? on-screen preview first?), whether any date-range/filter configuration step precedes the actual output, and whether "Share" produces a copyable link, an email prompt, or something else. **Future test requirement:** in a session where activating a Print/Share/Export control is explicitly authorized, click each one individually and observe (a) whether a configuration step appears first, (b) the resulting output format, and (c) whether the action is reversible/re-triggerable or has any one-time side effect (e.g., a "Share" link that can't be revoked).

**No separate "Staff statistics," "Vacation report," or dedicated "Request report" screen was found** anywhere in the sidebar, the Scheduling admin accordion, or via the DOM sweep technique used successfully in Phase 3 to find the previously-missed "Staff Rules" screen (re-run informally this phase against the current page set with no new nav items surfacing). **[OBSERVED — absence, not presence]** The most likely explanation, consistent with SM-02's Stipend finding, is that "Staff statistics" is what Shift Statistics (ADM-04) already provides when filtered/viewed per-staff rather than per-shift-type, and "Vacation/Request reports" are what the Master Schedule Print menu's **Requests** option produces — i.e., these are **views/exports of existing data, not separate screens**, matching the pattern already established for Stipend. **[INFERRED]**

## SM-03 — Contacts: row interactivity (new, left deliberately untested)

- **[OBSERVED, via computed style, not by clicking]:** every contact-list row (`<tr>`) has `cursor: pointer` in its computed CSS and no inline `onclick` attribute (consistent with a framework-bound click handler rather than a plain link) — this is suggestive that clicking a row does *something* (most commonly, in this kind of UI, opening a read-only detail view), but this is exactly the class of "control whose effect has not already been definitively established as read-only" that this phase's safety boundary requires leaving alone.
- **Marked UNRESOLVED per the new protocol:** control = "contact list row," location = Contacts (`/app/contacts`), behavior unknown. **Future test requirement:** in an authorized follow-up, click exactly one contact row and observe whether it (a) opens an in-page detail drawer/modal (expected, read-only outcome), (b) navigates away, or (c) has any other effect — before assuming any contact row anywhere else is safe to click.
- **Contact grouping [OBSERVED, recap from Phase 1]:** quick filters **All / Staff / Locum / None** remain the only grouping mechanism found; no separate "Contact Groups" admin concept distinct from Staff Groups (ADM-06) was found.
- **Row count [OBSERVED]:** 66 rows on this tenant's Contacts screen under groupId 8 — a different figure from the 94-row Users/Staff admin table for the same group (Phase 3), meaning Contacts is **not** a 1:1 mirror of the Users table; it likely excludes some Access Level types (e.g., `View`/`Telecom` functional accounts) or applies its own filter. **[OBSERVED the count discrepancy; UNRESOLVED the exact filter rule]**

## SM-04 — Messaging interface (Contacts bulk actions, recap + structural detail only)

- **[OBSERVED, recap]:** Send Email, Send SMS, Export, Print buttons exist above the Contacts table, each requiring row checkboxes to be selected first (implied by their positioning and the presence of per-row checkboxes).
- **Composition fields, templates, attachments, delivery options:** **[UNRESOLVED]** — none of these bulk-action buttons were clicked (Send/Email/SMS/Export are all in this batch's explicit do-not-click list), so no composition form was ever seen. **Future test requirement:** with explicit authorization and zero real recipients selected (if the UI permits opening the compose form without a recipient), inspect the Send Email/Send SMS form's fields without sending.
- **Validation visible without submission:** none observed (form never opened).
- **Permission restrictions:** **[INFERRED]** likely gated the same way as other bulk/admin actions (Scheduler-level or above), consistent with 02-role-permission-matrix.md; not independently re-tested.

## SM-05 — Documents (recap + one new negative finding)

- **[OBSERVED, new this phase]:** no search or filter input exists anywhere on the Documents screen — confirmed via a full interactive-element read of the page (`read_page`), which returned only the category tree, **Add Category**, and **UpLoad File** as interactive controls. Navigation is exclusively via the category tree; there is no way to search across categories or filter the file list by name/type/date.
- **Categories, metadata columns, empty states [OBSERVED, recap from Phase 1]:** File Name / File Size / Upload Date columns; category list unchanged from Phase 1.
- **File types [OBSERVED, recap]:** at least `.pdf` confirmed present (the two files noted in Phase 8, not opened).
- **Observable size restrictions:** **[UNRESOLVED]** — no stated size limit was visible anywhere (would only surface on the Upload form, not opened).
- **Naming behaviour:** **[OBSERVED]** filenames are free-text and human-authored (e.g., descriptive titles), not a fixed or system-generated naming scheme.
- **Role-based access:** **[UNRESOLVED]** whether categories like "Financial" or "Ohip Billing" are hidden from lower-privileged roles — not testable without a second account.
- **Upload/Delete/Archive controls [OBSERVED existence, recap]:** UpLoad File and per-file Delete buttons exist; neither clicked, this phase or any prior.
- **Audit/provenance:** **[UNRESOLVED]** — Upload Date is the only provenance field visible; no "uploaded by" or version-history information was found.

## SM-06 — Profile, notifications, group defaults (recap only — no new fields found)

PL-03 (Profile), PL-02 (Notification Settings), ADM-01 (Group Settings) were revisited to confirm nothing had changed and no field had been missed; all match their Phase 1/3/6 documentation exactly. No new findings.

## SM-07 — Help, Tours, Support (consolidated)

- **Help:** see SM-01 — the one instance found (Vacation) is an unimplemented stub. **[UNRESOLVED]** whether other screens have their own Help buttons at all; none were noticed elsewhere in eight prior phases of otherwise-thorough screen-by-screen coverage, suggesting Help may be a Vacation-specific (and currently non-functional) addition rather than a product-wide feature.
- **Tours:** the top-bar **Tour** link (`href="javascript:void(0)"` on every page) has never produced a visible effect across any phase of this research, including a repeat attempt in Phase 1. **[UNRESOLVED, carried forward]** — not re-tested this phase, consistent with "do not click controls merely to discover what they do" now that it has already failed to demonstrate an effect twice.
- **Support:** external link to `ischedulemd.zendesk.com` (recap, Phase 1) — a third-party Zendesk instance, out of scope for this product's own UI investigation.

## SM-08 — Calendar and external integrations (recap + confirmation)

- **Calendar-feed behaviour [OBSERVED, recap from Phase 4]:** the `webcal://` Subscribe link on My Schedule remains the only calendar integration found. Its authentication token was not re-inspected or copied this phase (already documented, structure-only, in 03-user-workflows.md WF-23).
- **No other external integration** (SSO, EHR, paging system, calendar-provider OAuth connection, etc.) was found anywhere in this or any prior phase. **[OBSERVED absence]** — this remains a notable gap for a hospital-facing scheduling product, worth a deliberate design decision in SchedulePoint (build the integration surface area needed, or explicitly scope it out).
- **External-link destinations found across the product to date:** Support → Zendesk; Help → an internal `ComingSoon.pdf` stub (not truly external, but a static file rather than in-app content).

## SM-09 — Remaining unclassified surfaces

A final sweep (link-label + href inspection only, on every screen already visited across all nine phases) did not surface any additional navigable screen beyond the ones already catalogued in 01-application-map.md's screen inventory and 02-role-permission-matrix.md's ADM-11/SYS-05 additions. **[OBSERVED — negative finding]** The application's full navigable surface, to the depth reachable by a Scheduler-level account without a mutating click, appears to have been exhaustively mapped across Phases 1–9.

---

## Master checklist — Phase 9 topics

| Topic | Status |
|---|---|
| Shift statistics | **[OBSERVED]** (recap, ADM-04) |
| Staff statistics | **[INFERRED]** — no separate screen; likely a filtered view of Shift Statistics |
| Schedule / Request / Vacation / Picklist / Stipend reports | **[OBSERVED]** existence as Master Schedule Print-menu export types (Schedule/Picklist/Stipend/Requests); **[INFERRED]** Vacation reporting likely folds into "Requests"; **[UNRESOLVED]** actual output/format for all of them |
| Printable views / export configuration / formats | **[OBSERVED]** control existence only; **[UNRESOLVED]** everything about their actual behavior — none activated |
| Contacts / contact groups | **[OBSERVED]** — SM-03, row count discrepancy vs. Users table noted |
| Messaging interfaces | **[OBSERVED]** existence; **[UNRESOLVED]** composition form — never opened |
| Documents / document categories | **[OBSERVED]** — SM-05, confirmed no search exists |
| Profile / notification preferences / group defaults | **[OBSERVED]** — no changes since Phase 1/3/6 |
| Help / Tours / Support | **[OBSERVED]** — Help is a stub; Tour remains non-functional across all attempts; Support is external |
| Calendar integrations / external integrations | **[OBSERVED]** — only the webcal feed exists; no other integration found anywhere in the product |
| Unclassified remaining pages | **[OBSERVED]** — negative finding; no new screens found beyond the existing inventory |

---

## Safety & boundary notes

- No control associated with any of the batch's listed action verbs was clicked.
- The Vacation "Help" click registered on the page with no visible effect and no URL change — confirmed via `tabs_context` immediately after — and its destination was subsequently inspected read-only via `href`, never opened.
- Print/Share/Export buttons on Master Schedule, On Call, and Shift Statistics were catalogued via DOM inspection (tag, text, `href`) only; none were clicked, and the Master Schedule Print dropdown was opened only as far as reading its four labeled sub-items.
- Contacts row-click behavior was deliberately left untested despite suggestive `cursor:pointer` styling, per the new "do not click merely to discover" rule; recorded as an explicit future test requirement instead.
- No document was opened, downloaded, or previewed.
- No credentials, tokens, cookies, patient information, private feed URLs, document contents, or unnecessary personal data were captured; one JavaScript inspection call was auto-blocked by the tooling itself for containing cookie/query-string-shaped data, and the query was immediately narrowed to avoid that class of data entirely rather than retried.

## Evidence & follow-up

- Screenshots not yet exported to disk (standing limitation across all nine phases).
- Every "future test requirement" noted above (SM-01 through SM-04) should be treated as a discrete, explicitly-authorized follow-up task, not bundled into a future broad exploration pass.
- Findings merged into [source-page-index.md](source-page-index.md), [unresolved-questions.md](unresolved-questions.md), [evidence-register.md](evidence-register.md), [manifest.json](manifest.json).
