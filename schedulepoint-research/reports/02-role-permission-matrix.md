# 02 — Role, Account & Permission Surfaces: ischedule.MD

**Phase:** 3 — Role/account/organization/group/site/department/user-administration/proxy/locum/scheduler/special-permission/group-switching audit.

**Method:** Read-only inspection per [RESEARCH-RULES.md](../RESEARCH-RULES.md). All navigation used normal, authorized links and menus already available to the signed-in session (no access-control bypass). Where a control's purpose could only be confirmed by submitting it (approve, publish, delete, impersonate, save), it was left unresolved rather than exercised. This report **merges into** [01-application-map.md](01-application-map.md) by stable ID — screens already documented there (ADM-05, NAV-02, SYS-01, SYS-02, VAC-02, CON-01, ADM-06) are **updated/corrected** here, not re-described from scratch; only the delta is written out, plus a small number of newly-discovered IDs (ADM-11, SYS-05, GRP-01, ROLE-01…06).

**Evidence labels:** **[OBSERVED]** seen directly · **[INFERRED]** concluded from strong indirect evidence · **[UNRESOLVED]** open question, not resolvable without a mutating action or a different-role session.

**Exclusions honored:** No real names, personal emails, or personal phone numbers from the staff/user rosters are reproduced below. Where an example is needed to illustrate a cross-group role difference, staff are referred to by anonymous labels (**Staff-A**, **Staff-B**, …) that are *not* tied to any name printed elsewhere in this or prior reports. No credentials, tokens, or session cookies were captured or are reproduced. No patient information was encountered in this phase (this phase did not touch clinical/case-level screens).

---

## 1. Correction/update to Phase 1 — the Scheduling admin accordion has 11 items, not 10

**[OBSERVED, supersedes 01-application-map.md §2.3]** A DOM-level sweep of the sidebar (comparing rendered links against a full `<a href>` scan) found an **11th item, "Staff Rules"** (`/admin/staffrules`), positioned after "Pattern Rules," that was missed during Phase 1's manual pass. Phase 1's §2.3 list should be read as:

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
11. **Staff Rules — `/admin/staffrules`** ← new, see ADM-11 below

Also newly confirmed: the user-menu's **"Sign In As"** (Phase 1 SYS-02) is not a `javascript:void(0)` no-op as assumed — it has a real destination, `/admin/signas` (see SYS-05 below).

**Method note for future passes:** a plain visual/manual click-through can miss real, visible nav items (this one was genuinely rendered and visible, just missed). A quick DOM `querySelectorAll('a[href]')` sweep of the sidebar is a cheap, effective completeness check and is recommended as a standard step early in any future exploration phase.

---

## 2. ADM-11 — Staff Rules *(new screen)*

- **URL:** `/admin/staffrules`
- **Nav path:** Sidebar → Scheduling → Staff Rules
- **Purpose:** a **per-staff-member, named-individual constraint/penalty engine**, distinct from and more granular than the general Pattern Rules (ADM-10, which operate on shift/shift-group codes, not named people).
- **Roles:** admin/scheduler-tier only [INFERRED — same accordion gating as the rest of Scheduling]
- **Schema [OBSERVED]:** ID (`SR#`), **Staff Rule Name** (free-text label), **Rule** — a small DSL of the shape:
  `WHEN ASSIGN (<shift>) IF [<other shift>][<day-offset>] Assigned [<Person>,<Person>] THEN Penalty [-<N>][<Person>,<Person>]`
  i.e., "if these two named people are ever assigned this specific pair of shifts within this day-offset window, apply a negative fairness-score penalty of N." **Days** column scopes the rule to a weekday (e.g. Saturday, Friday). **Delete / Edit** per row, **Add New** top action (none exercised).
- **6 rules observed** in this tenant, all following the identical shape: a weekend/Friday cardiac-call shift paired with a same/adjacent-day ICU-daytime shift, naming two specific staff members per rule, with penalty magnitudes ranging from roughly -5,000 to -20,000 (an order of magnitude larger than the Shift Groups' "Linear (1000)" weight seen in ADM-08 — suggesting these are much stronger discouragements, tuned per-pair, layered on top of the general fairness model).
- **Data model implication:** the fairness/constraint system is **three-layered**: (1) Pattern Rules (ADM-10) — general, shift-code-scoped spacing constraints; (2) Shift Groups' Equation & Weight (ADM-08) — general credit-weighting for scoring fairness; (3) **Staff Rules (this screen)** — named-individual, named-pair penalty overrides for specific known conflicts (e.g., two people who should not both be on a particular pair of shifts, for reasons the schedule data itself doesn't otherwise capture — could be a real operational reason like a supervision requirement, a coverage rule, or simply a manually-discovered scheduling conflict that recurred and got hard-coded as a rule).
- **Related screens:** ADM-10 (Pattern Rules — same rule-engine family, different scope), ADM-02 (Builds — these rules almost certainly get evaluated during Build/Fix Picks), ADM-04 (Shift Statistics — penalty magnitudes here likely feed the same Credits/Target/Actual accounting)
- **Open questions:** Whether penalties here are a hard block (build fails/refuses) or a soft optimization signal (build still succeeds but scores worse); who authors these rules operationally (are they added reactively after a scheduling conflict, or proactively?). [UNRESOLVED]
- **screenshot_ref:** `screenshots/admin/staff-rules-01.png` (not yet exported to disk)

---

## 3. SYS-05 — Sign In As *(new screen; expands on SYS-02)*

- **URL:** `/admin/signas`
- **Nav path:** Top bar → user menu → Sign In As
- **Purpose:** admin/scheduler impersonation — sign into the application as a different staff member, presumably for support/troubleshooting (e.g. "why can't this person see their picklist") or for acting on behalf of someone (e.g. a scheduler entering a request for a staff member who called it in by phone).
- **Roles:** available in the current (Scheduler-level) session's user menu; not verified for lower-privileged roles [UNRESOLVED]
- **Structure [OBSERVED, form fields only — not submitted]:** a two-step, explicit-confirmation form:
  1. **Group** — a dropdown defaulting to the *other* group/site than the one currently active (i.e., choosing which group's roster to impersonate within — impersonation is scoped per-group, consistent with role/membership itself being per-group, see §5)
  2. **Staff** — a "Select User…" combobox (a custom searchable widget, not a plain HTML `<select>`; its option list is populated dynamically and was not enumerated, to avoid both an accidental selection and unnecessary capture of the full personal roster)
  3. A **"Stay signed in"** checkbox (session-persistence option for the impersonated identity)
  4. A **SIGN IN** button — the actual mutating/identity-changing action
- This form was **not submitted** at any point (no group was changed here, no staff member was selected, "SIGN IN" was never clicked) — the screen was inspected purely by loading it and reading its static markup.
- **Related screens:** ADM-05 (Staff/Users — presumably the "Staff" combobox here is scoped to that group's user roster), GRP-01 below (per-group scoping pattern)
- **Open questions:** Is impersonation available to every role that can see the "Sign In As" menu item, or gated further server-side even if the link is visible? Does impersonation preserve the *impersonated* user's own role/permissions (expected) or the *impersonator's*? [UNRESOLVED — not testable without submitting the prohibited action]
- **screenshot_ref:** `screenshots/admin/sign-in-as-01.png` (not yet exported to disk)

---

## 4. GRP-01 — Group/site switching behavior *(new finding, expands SYS-01)*

**[OBSERVED]** The signed-in account belongs to two groups (Phase 1 called these "THP C Site" and "THP M/Q Site"). Switching the active group via the top-nav dropdown was exercised (then switched back), with the following confirmed:

- **Full sidebar parity across groups:** every nav item, including the entire Scheduling admin accordion and Picklist Manager, remained visible and reachable after switching groups. The account's elevated access is **not** a quirk of one specific group — it holds the same **Access Level ("Scheduler")** in both groups (cross-checked directly on each group's own `/admin/users` roster — see §5).
- **Per-group request-window state differs:** the "My Schedule" page's My Requests panel showed **"(CLOSED)"** with a **PENDING** filter button on one group, versus **"(UNTIL DECEMBER 18, 2026)"** with an **ALL** filter button on the other — confirming the request-submission window (Group Settings' "Request Until Date," ADM-01) is an independent per-group setting, not shared.
- **Completely independent user rosters, of different sizes:** one group's `/admin/users` listed **94** users; the other listed **103**. These are not the same 94 people re-labeled — most individuals only appear on one roster or the other, and a meaningful subset appear on **both** rosters but with a **different Access Level per group** (see §5, this is the single most important role-model finding of this phase).
- **`/vacation/index`, `/app/schedulenew`, etc. all re-scope silently** to the newly active group's own data on next load — consistent with the `groupId` URL parameter (`#groupId=8` vs `#groupId=7`) driving every data-bound screen.
- The **default-group preference** (Phase 1's PL-03, "Save Default Group") is a separate, persisted setting from this live switcher — switching here is a session-only context change, not a saved preference change, and was not saved.
- **Open questions:** Whether a lower-privileged (e.g. Staff or Locum) account also sees both groups it belongs to in this same switcher, or only ever operates in one group at a time. [UNRESOLVED]

---

## 5. Role model — corrected and substantially expanded

**[OBSERVED — this supersedes Phase 1 §5 entirely.]** Phase 1 reported three Access Level values (Staff, Scheduler, Locum) based on a single page of the Users table. A full paginated read of **both** groups' `/admin/users` rosters (94 + 103 = 197 rows, 9 pages total) plus a direct read of the Access Level dropdown's option list (confirmed by two independent methods — data-scan and DOM inspection of the edit-row `<select>` element) establishes **six** distinct Access Level values:

| Access Level | Confirmed by | Approx. share of rows seen | Characteristic flag pattern [OBSERVED] |
|---|---|---|---|
| **Staff** | dropdown options + majority of rows | largest single group | Admin Emails: No · Picklist Admin: No · Show In Grid: **Yes** · often has a non-empty "Picks Excluded" value |
| **Locum** | dropdown options + many rows | second-largest group | Same flag pattern as Staff in most rows, but **Show In Grid is No** for a number of Locum rows (not all) — consistent with Locums being relief staff not always rendered on the standing Master Schedule grid |
| **View** | dropdown options + ~10 rows across both groups | small, distinct group | **No phone numbers in several rows**, Admin Emails: No, Picklist Admin: No, Show In Grid: **No** — consistent with a **read-only** role; several View-role accounts are clearly **functional/shared accounts** rather than individual people (see §6) |
| **Telecom** | dropdown options + a large cluster on one group's roster only | present on one group, essentially absent on the other | Almost uniformly: Admin Emails: **Yes**, Picklist Admin: No, Show In Grid: **No**, no cell/home phone recorded — consistent with hospital switchboard/telecom-department staff who need to *receive* on-call/admin notifications but never appear in the schedule or run picklists themselves |
| **Scheduler** | dropdown options + a handful of rows in each group | smallest named-individual tier besides Genius | Variable Admin Emails/Picklist Admin flags **even within the same Access Level** (some Scheduler rows show Yes/Yes, others No/No — see the "Access Level + flags" note below); this is the tier the session used for this entire review holds |
| **Genius** | dropdown options + 2-3 rows per group | rarest tier | Assigned to at least one clearly-functional/office account (a scheduling-office shared mailbox) and at least one named individual account, in both groups observed; flag pattern otherwise similar to Scheduler |

**Key structural finding — role is scoped per group membership, not per account globally:** the same real person (matched by identical email address) was observed holding a **different Access Level in each of the two groups** in several cases — e.g. one staff member was **Staff** in one group and **Locum** in the other; another was **Locum** in one group and **Staff** in the other; another was **Genius** in one group and **Locum** in the other. This was independently corroborated for **multiple distinct individuals**, not a single coincidence. **[OBSERVED, high confidence]** A person's "role" in this product is therefore a property of their **membership row in a specific group's roster**, not a single global attribute of their account.

**Access Level is not the only permission axis.** Two boolean flags — **Admin Emails** and **Picklist Admin** — vary independently of Access Level, including among multiple **Scheduler**-level rows (some have both flags set to Yes, others — including the session's own account — have both set to No). Despite the reviewing session's own account having **Picklist Admin: No**, it still had full, unrestricted access to Picklist Manager, the Dashboard monitor, and every Scheduling admin config screen throughout this entire review. **[OBSERVED, high confidence]** This strongly indicates:
- **Access to the admin surfaces (Scheduling accordion, Picklist Manager, Dashboard) is gated by Access Level ("Scheduler"/"Genius") itself**, not by the "Picklist Admin" flag.
- **"Picklist Admin" and "Admin Emails" are finer-grained, independent grants** layered on top of Access Level — most plausibly controlling things like: whether the user is CC'd on system/admin notification emails (Admin Emails), and some as-yet-unconfirmed additional picklist-specific capability or notification scope (Picklist Admin) that this session's own account did not need in order to fully operate the picklist tooling it has access to. **[INFERRED — the exact extra capability granted by "Picklist Admin: Yes" beyond what a Scheduler already has is UNRESOLVED]**

**"Genius" is very likely the top privilege tier, but this is not directly confirmed.** No session with Genius-level access was available to this review (the account used is Scheduler-level), and impersonating a Genius-level account via Sign In As is explicitly prohibited. The name itself, its rarity, and its assignment to what look like the most senior/central accounts in each group (a physician who also appears with elevated flags elsewhere, and the group's own central scheduling-office account) all point toward Genius sitting above Scheduler, but **no capability was found in this review that a Genius account can do and a Scheduler cannot** — that comparison is **[UNRESOLVED]**.

**A likely separate, out-of-band vendor/support tier exists.** One account, using the product's own domain in its email address rather than the hospital's, with the display name literally rendered as "Super" (as in, the account's own first/last name fields spell out a superuser identity) is provisioned inside the tenant's ordinary user list, in one group, with Access Level shown simply as **Scheduler** and **Notification Locked: Yes**. **[OBSERVED the row exists; INFERRED it represents vendor/support access — its Access Level being ordinary "Scheduler" rather than a distinct "Superadmin" value suggests either (a) true top-level administration happens entirely outside this UI/tenant, in a vendor back-office not exposed to any tenant user, or (b) this row is simply how the vendor's own support staff sign in when helping this specific tenant, with no special powers beyond an ordinary Scheduler.]** This is flagged as a security-relevant observation regardless of which explanation is correct: a vendor-controlled account with tenant-facing credentials exists inside the customer-visible user roster.

---

## 6. Functional / shared (non-person) accounts

**[OBSERVED]** Several rows in the Users table are clearly not individual staff members but **shared or system-purpose accounts**, identifiable by their name field and/or email domain rather than any special flag:

- A functional account representing a physical location's front desk / operating-room reception point (View role), addressed via what reads as a shared departmental mailbox rather than a person's name.
- A functional account representing "the anesthesia assistant" role generically rather than a named individual (View role), addressed via a shared/role-based mailbox at the hospital's own domain.
- A functional account representing the group's own central scheduling office (Genius role in one group), again a shared departmental mailbox rather than a person.
- At least two **placeholder Locum accounts** with no phone numbers and email addresses on the product's own domain rather than the hospital's or a personal address — functioning as **assignable stand-ins** for a locum slot that hasn't been filled with a named individual yet ("Locum TBA"-style, and a second, sequentially-numbered one).
- A placeholder account representing a generic scheduled day off rather than a specific person, also on a personal-looking free-mail address, Locum role.

**Data model implication:** the underlying "staff member" entity in this product is not constrained to represent only real clinicians — it is used more generally as an **assignable identity slot**, which can represent a real person, a shared departmental contact point, or an explicit placeholder for "not yet assigned" / "day off." Any clean-room reimplementation should decide deliberately whether to model this the same way (one polymorphic "assignee" entity) or split it into distinct "real staff" vs. "placeholder/functional slot" entities — the latter is arguably cleaner but the original product's approach (reusing one user/role table for both) is simple to build and explains why roles like View and Locum have several non-person examples.

---

## 7. "Department" — searched for, not found as a distinct entity

**[UNRESOLVED / negative finding]** No distinct "Department" administrative entity, screen, or grouping concept was found anywhere in this phase's exploration (Group Settings, Staff Groups, Shift Groups, the Users table, and the sidebar were all checked). The only appearance of the word "Department" anywhere in the product is as the **name of one folder/category inside Documents** (`/app/documents`), which is just a document-library label, not an organizational unit with its own membership, permissions, or admin screen. If a hospital-department concept (e.g., "Anesthesia," "Cardiac Surgery," distinct from the Group/Site tenancy already mapped) exists in this product, it was not surfaced anywhere reachable from the current account's navigation.

---

## 8. Role-permission matrix

Confidence key: **High** = directly observed by navigating there in this session · **Medium** = strongly inferred from consistent, corroborated indirect evidence (flag patterns, UI copy, cross-group comparison) · **Low/Unresolved** = plausible but not adequately evidenced, would require a different-role session or a prohibited mutating action to confirm.

| Capability | Staff | Locum | View | Telecom | Scheduler | Genius | Evidence IDs |
|---|---|---|---|---|---|---|---|
| View own personal schedule (SCH-01) | Yes (Med) | Yes (Med) | Yes (Med) | Unresolved | **Yes (High, observed)** | Unresolved | SCH-01 |
| View On Call directory (SCH-05) | Yes (Med) | Yes (Med) | Yes (Med) | Yes (Med — this is plausibly Telecom's core purpose) | **Yes (High)** | Unresolved | SCH-05 |
| View org-wide Master Schedule / Daily Assignments | Unresolved (Low) | Unresolved (Low) | Yes (Med — "View" naming) | Unresolved | **Yes (High)** | Unresolved | SCH-02/03/04, DA-01 |
| Appear on the Master Schedule grid ("Show In Grid") | Mostly Yes (High, flag-observed) | Mixed — some Yes, some No (High, flag-observed) | No (High, flag-observed) | No (High, flag-observed) | Varies by row (Med) | Varies (Med) | ADM-05 |
| Edit/batch-modify the schedule (Batch Add/Delete) | No (Med) | No (Med) | No (Med) | No (Med) | **Presumed Yes (Med — not exercised)** | Presumed Yes (Low) | SCH-02/03/04 |
| Run/administer the Builds pipeline, incl. "Erase Master Schedule" | No (Med) | No (Med) | No (Med) | No (Med) | **Presumed Yes (Med — screen reachable, not exercised)** | Presumed Yes (Low) | ADM-02 |
| Access Scheduling admin config (Group Settings, Shifts, Shift/Staff Groups, Pattern/Staff Rules, Valid Groups, FTE, Statistics) | No (Med) | No (Med) | No (Med) | No (Med) | **Yes (High, observed this whole session)** | Presumed Yes (Low) | ADM-01,02,03,04,06,07,08,09,10,11 |
| Run Picklist Manager (Start List / Fix Picks / Publish / Lock / Email participants) | No (Med) | No (Med) | No (Med) | No (Med) | **Yes (High, screen reachable; mutating actions not exercised)** | Presumed Yes (Low) | PLM-01, DASH-01 |
| Manage Users (Add/Edit/Remove, set Access Level & flags) | No (Med) | No (Med) | No (Med) | No (Med) | **Yes (High — inline edit opened, then cancelled)** | Presumed Yes (Low) | ADM-05 |
| Approve/Deny/Transfer vacation requests | No (Med — "Approval Required **By Scheduler**" naming) | No (Med) | No (Med) | No (Med) | **Presumed Yes (Med — matches the "By Scheduler" setting name; buttons visible, not clicked)** | Presumed Yes (Low) | VAC-01, VAC-02 |
| Bulk-message staff (Send Email/SMS from Contacts) | Unresolved | Unresolved | Unresolved | Unresolved | Buttons visible, not exercised (Low) | Unresolved | CON-01 |
| Impersonate another user (Sign In As) | Unresolved — link not confirmed absent for this role | Unresolved | Unresolved | Unresolved | **Menu item present and screen reachable (High); never submitted** | Unresolved | SYS-05 |
| Switch between the account's own groups/sites | N/A unless multi-group (Unresolved for these roles) | N/A unless multi-group | N/A unless multi-group | N/A unless multi-group | **Yes (High, exercised both directions)** | Unresolved | GRP-01, SYS-01 |
| Receive admin/system notification emails ("Admin Emails" flag) | Rare, per-individual (Med) | Rare, per-individual (Med) | No, uniformly observed (High) | **Yes, uniformly observed (High)** | Varies per row (Med) | Varies (Med) | ADM-05 |
| Participate in the picklist draft (i.e., has a pick order / "Picks Excluded" is meaningful) | Yes (Med) | Yes (Med) | No — no such data on View rows (High) | No — no such data on Telecom rows (High) | Unclear whether Schedulers also personally pick (Unresolved) | Unresolved | ADM-05 |
| Configure own notification escalation ladder (PL-02) incl. Pick Proxy delegation | Presumed Yes, self-service (Med) | Presumed Yes (Med) | Unresolved | Unresolved | **Yes (High, own settings inspected)** | Unresolved | PL-02 |

**Overall confidence statement:** every row/column for the **Scheduler** role is backed by direct, first-hand navigation in this session (High confidence) with the sole caveat that no *mutating* admin action (Approve, Publish, Delete, Add, Sign In As's final submit) was actually executed, so "can reach the control" is confirmed but "the control succeeds and does exactly what its label implies" remains a reasonable but technically **[INFERRED]** step for those specific actions. Every row for **Staff, Locum, View, Telecom, and Genius** is **[INFERRED]** from flag patterns, screen-derived UI copy (e.g., "By Scheduler"), and cross-group comparison — **no session was ever conducted as any role other than Scheduler**, so these remain the most valuable target for a follow-up phase if a lower-privileged test account becomes available.

---

## 9. Safety & boundary notes for this phase

- No approval, denial, transfer, publish, lock/unlock, delete, add, save, or "Sign In As → SIGN IN" action was executed anywhere in this phase.
- The **Sign In As** form (SYS-05) was loaded and its static fields read, but the Group was left at its default, no Staff member was ever selected, and **SIGN IN** was never clicked.
- The **Select Proxy User** combobox on Notification Settings (PL-02) was deliberately **not** clicked open, since it is a custom widget whose option list would only populate on interaction, and enumerating a full personal-name roster there was judged unnecessary given the roster was already fully characterized via the Users admin table.
- Group switching (GRP-01) was treated as ordinary, reversible navigation (consistent with RESEARCH-RULES' "view selectors" allowance) rather than a setting change, since it did not touch "Save Default Group" and reverted cleanly by switching back.
- The full 197-row combined user roster (94 + 103 rows across both groups) was read via normal, authorized pagination controls already present in the admin UI the session has legitimate access to — this is standard navigation, not a bypass of any access control, rate limit, or pagination guard.
- Real names, emails, and phone numbers encountered while reading the roster (necessary to detect the cross-group role-change pattern in §5) are **not reproduced** anywhere in this report; all illustrative examples are described generically ("one staff member," "a physician account," "a scheduling-office account") without linking back to any specific printed name.

---

## 10. Unresolved questions raised by this phase (see also companion file)

1. Does a Staff, Locum, View, or Telecom-level session see a different (smaller) sidebar than the one used throughout this review? Not testable without a different-role account or prohibited impersonation.
2. What does "Picklist Admin: Yes" grant beyond ordinary Scheduler access, given a Picklist-Admin-less Scheduler account already had full Picklist Manager access?
3. What does "Admin Emails: Yes" actually deliver (which specific system emails)?
4. Does "Genius" carry any capability beyond "Scheduler"? No comparison was possible.
5. Is the "Super"-named, vendor-domain account a genuine elevated-privilege backdoor, or an ordinary-privilege support login? Its visible Access Level ("Scheduler") suggests the latter, but this can't be confirmed from the UI alone.
6. Does impersonation (Sign In As) assume the impersonated user's permissions, or retain the impersonator's own?
7. Is there any true "Department" concept anywhere in the product beyond a Documents folder name? None found in this phase.
8. What determines whether a Locum-role row has "Show In Grid: Yes" vs "No" — is it a manual per-row toggle, or derived from something else (e.g., whether they have any current assignments)?
9. Who can select who as a "Pick Proxy" — is it restricted to people in the same group, same role, or unrestricted? Not enumerated (see Safety notes).

---

## 11. Evidence & follow-up needed

- Screenshot files for this phase's new/updated screens were **not** exported to disk (same limitation as Phase 1) — `screenshot_ref` values above are target paths for a future capture pass.
- This report's open items should be merged into [unresolved-questions.md](unresolved-questions.md) (done — see that file's entries added for Phase 3).
- ADM-11 and SYS-05 should be added to [source-page-index.md](source-page-index.md) (done).
- This report itself should be logged in [evidence-register.md](evidence-register.md) as a text-evidence artifact (done).
