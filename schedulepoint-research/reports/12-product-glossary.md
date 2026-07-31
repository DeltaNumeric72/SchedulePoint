# 12 — Product Glossary: iSchedule.MD → SchedulePoint

**Phase:** 13 — research consolidation. **Source:** reports 01–11 plus the final coverage audit. **No source-site navigation was performed in this phase.**

**Purpose:** a single normalized vocabulary for SchedulePoint, reconciling every term encountered across twelve research phases. Where the source product used one word for two concepts, this glossary **splits** them. Where it used two words for one concept, this glossary **merges** them. Where a term is actively misleading, this glossary marks it **AVOID**.

---

## Classification key

| Code | Meaning |
|---|---|
| **OBS** | OBSERVED — the term and its meaning were directly confirmed on screen in iSchedule.MD |
| **INF** | INFERRED — meaning strongly supported by evidence but not directly confirmed |
| **UNR** | UNRESOLVED — the term exists but its precise meaning was never established |
| **SP-REQ** | SCHEDULEPOINT REQUIREMENT — a term SchedulePoint must introduce, regardless of source usage |
| **SP-REC** | SCHEDULEPOINT RECOMMENDATION — a proposed term change requiring product-owner approval |

**Confidence:** High / Med / Low — how firmly the *definition* is established, independent of classification.

**Disposition vocabulary:** `RETAIN` (keep the source term) · `RENAME` (same concept, better name) · `SPLIT` (source term conflates ≥2 concepts) · `MERGE` (several source terms, one concept) · `INTRODUCE` (new term, no source equivalent) · `AVOID` (do not use this word in SchedulePoint at all).

**Field key:** **SP** = preferred SchedulePoint term · **Src** = source-site term(s) · **Actors** = who uses/encounters it · **Feat** = related feature IDs (13-feature-inventory.md) · **Ent** = related entity IDs (14-domain-model.md) · **Ev** = source reports/evidence · **Amb** = ambiguities or conflicting meanings · **Disp** = disposition.

---

## A. Tenancy and organizational structure

#### TERM-001 · Organization
**SP:** Organization · **Src:** *(none — no such concept exists in the source)* · **Class:** SP-REQ · **Conf:** n/a
**Def:** The top-level customer/tenant that owns everything: billing entity, security boundary, and the root of all data ownership. One Organization contains one or more Groups.
**Actors:** platform operator, org administrator · **Feat:** FEAT-001 · **Ent:** ENT-001
**Ev:** 01-app §1 (tenancy via `groupId` only); 02-role §4 (GRP-01); 10-technical §4
**Amb:** The source has **no organization layer at all** — `groupId` is the only tenancy parameter, and the two observed groups behave as fully independent silos (independent rosters, independent settings, independent vacation blocks) with no shared parent visible anywhere in the UI. Whether a parent exists server-side is **UNRESOLVED**.
**Disp:** **INTRODUCE.** SchedulePoint needs an explicit Organization above Group so that cross-group reporting, shared staff identity, and billing have a home. This is a deliberate structural addition, not an observation.

#### TERM-002 · Group
**SP:** Group · **Src:** "Group", "Site" (used interchangeably in the UI) · **Class:** OBS · **Conf:** High
**Def:** The primary scheduling and permission scope. A Group has its own staff roster, shift catalogue, rules, vacation block, picklists, settings, and schedule. **A user's role is a property of their membership in a specific Group, not of their account.**
**Actors:** all · **Feat:** FEAT-001, FEAT-002, FEAT-003 · **Ent:** ENT-002, ENT-006
**Ev:** 01-app §1, ADM-01; 02-role §4 (GRP-01), §5; 10-technical §4 (`groupId` in every data-bound route)
**Amb:** The source's own UI calls the same thing a "Group" in admin screens (`/admin/groups`, "Group Settings") and a "Site" in the top-bar switcher ("THP C Site"). Both refer to the identical `groupId` entity. See TERM-003.
**Disp:** **RETAIN** as the canonical term. Group is the scheduling scope; Site (TERM-003) must not be treated as a synonym in SchedulePoint.

#### TERM-003 · Site
**SP:** Site · **Src:** "Site" (in the group switcher label only) · **Class:** SP-REC · **Conf:** Med
**Def:** *Proposed:* a physical location (a hospital campus, a building) where work is performed. Distinct from Group, which is a scheduling/permission scope.
**Actors:** scheduler, staff · **Feat:** FEAT-004 · **Ent:** ENT-003
**Ev:** 01-app §1 (switcher labels); 02-role §4
**Amb:** **This is a genuine conflation in the source.** The two observed groups are named after physical hospital sites, so in that tenant Group and Site happen to coincide 1:1 — but nothing guarantees this in general. A single physical site could host two scheduling groups (e.g. anaesthesia and surgery), or one group could span two sites.
**Disp:** **SPLIT** from TERM-002, then **defer**. SchedulePoint should reserve "Site" for physical location and *not* use it as a synonym for Group. Whether Site becomes a first-class MVP entity is a product-owner decision (see FEAT-004, ENT-003) — the source provides no evidence either way.

#### TERM-004 · Department
**SP:** *(avoid)* · **Src:** "Department" (a Documents folder label only) · **Class:** OBS · **Conf:** High
**Def:** No organizational meaning in the source. The word appears exactly once, as the name of a document-library category.
**Actors:** n/a · **Feat:** FEAT-050 · **Ent:** *(none)*
**Ev:** 02-role §7 (searched Group Settings, Staff Groups, Shift Groups, Users, sidebar — none found); unresolved-questions #25 (answered)
**Amb:** A hospital-domain reader will assume "Department" is an org unit. In this product it is not.
**Disp:** **AVOID.** Do not introduce a Department entity in SchedulePoint's MVP. If departmental grouping is later needed, Staff Group (TERM-024) already provides the mechanism.

#### TERM-005 · Tenant isolation
**SP:** Tenant isolation · **Src:** *(none — implicit)* · **Class:** SP-REQ · **Conf:** n/a
**Def:** The guarantee that no data, action, or notification crosses an Organization or Group boundary except through an explicitly designed and authorized path.
**Actors:** platform · **Feat:** FEAT-001 · **Ent:** ENT-001, ENT-002
**Ev:** 11-edge-cases QA-TEN-001..012; 10-technical §4
**Amb:** The source scopes by `groupId` carried redundantly in a URL hash, a query parameter, **and** a cookie simultaneously — three sources of truth for the same value. Whether server-side authorization independently validates group membership on every request is **UNRESOLVED** (never tested; testing it was prohibited).
**Disp:** **INTRODUCE** as an explicit, tested architectural property. See QA-TEN-005, QA-TEN-012, QA-SEC-008.

---

## B. People, roles, and permissions

#### TERM-006 · User
**SP:** User · **Src:** "Staff", "User" (both used for the same admin table) · **Class:** OBS · **Conf:** High
**Def:** An authenticable account identified by email address. One User may hold membership in several Groups.
**Actors:** all · **Feat:** FEAT-005, FEAT-006 · **Ent:** ENT-004
**Ev:** 01-app ADM-05; 02-role §5, §6; 03-user WF-18/19/20
**Amb:** The source's sidebar labels the screen "Staff" while its route is `/admin/users` and its content includes non-person accounts. "Staff" and "User" are used interchangeably for a table that contains both.
**Disp:** **SPLIT** from TERM-008. User = the account; Staff Member = a person who can be assigned work. See TERM-007.

#### TERM-007 · Membership
**SP:** Membership · **Src:** *(none — implicit in the roster)* · **Class:** INF · **Conf:** High
**Def:** The join between a User and a Group, carrying the role and all per-group permission flags. **This is where a person's role actually lives.**
**Actors:** administrator · **Feat:** FEAT-005 · **Ent:** ENT-006
**Ev:** 02-role §5 — the same individual (matched by identical email) was observed holding **different Access Levels in each of two groups**, corroborated across multiple distinct individuals
**Amb:** The source has no visible "membership" screen — the concept is implicit in the fact that each group has its own roster row for the same person. Nothing in the UI names this relationship.
**Disp:** **INTRODUCE.** Making Membership explicit is one of the most important structural findings of the entire research effort; it is what makes per-group roles coherent.

#### TERM-008 · Staff Member
**SP:** Staff Member · **Src:** "Staff" · **Class:** OBS · **Conf:** High
**Def:** A person (or assignable identity) who can appear on a schedule, hold a pick position, and be assigned work within a Group.
**Actors:** all · **Feat:** FEAT-005 · **Ent:** ENT-004, ENT-006
**Ev:** 01-app ADM-05; 02-role §5, §6
**Amb:** "Staff" is used in the source for (a) the roster screen, (b) one specific Access Level value, and (c) the general population of schedulable people — three different scopes for one word.
**Disp:** **SPLIT.** Reserve "Staff Member" for the general population; use "Access Level: Staff" (TERM-011) only for the role value; never use "Staff" alone for the roster screen.

#### TERM-009 · Physician
**SP:** *(avoid as a system term)* · **Src:** "Dr. `<name>`" in confirmation copy · **Class:** OBS · **Conf:** Med
**Def:** The clinical profession of most staff members in the observed tenant. Appears in UI copy ("for Dr. X") but is **not** a system role, permission, or entity.
**Actors:** n/a · **Feat:** *(none)* · **Ent:** *(none)*
**Ev:** 03-user WF-08 (confirmation copy); 06-requests LC-01
**Amb:** Because the observed tenant is an anaesthesia department, "physician" and "staff member" coincide in practice — but the product is structurally profession-agnostic (Locums, telecom staff, functional accounts, and placeholder slots all coexist in the same roster).
**Disp:** **AVOID** in the data model. Profession, if ever needed, is an attribute of a Staff Member, not a role or entity. Keeping SchedulePoint profession-neutral preserves its applicability beyond anaesthesia.

#### TERM-010 · Access Level
**SP:** Role · **Src:** "Access Level" · **Class:** OBS · **Conf:** High
**Def:** The single enumerated permission tier held by a Membership. Six values observed: Staff, Locum, View, Telecom, Scheduler, Genius.
**Actors:** administrator · **Feat:** FEAT-006 · **Ent:** ENT-007
**Ev:** 02-role §5 (full paginated read of both rosters, 197 rows, plus dropdown option scan)
**Amb:** **Contradiction C-01** — Phase 1 initially recorded only three values from a single page of the table; the full enumeration found six. This is recorded as a *methodology* finding (partial enumeration produced a confidently wrong model), not an unresolved conflict.
**Disp:** **RENAME** to "Role." "Access Level" implies an ordered hierarchy (higher = more access), but the six observed values are not cleanly ordered — Telecom and View are *sideways* from Staff, not below it.

#### TERM-011 · Role value — Staff
**SP:** Role: Staff · **Src:** "Staff" · **Class:** OBS · **Conf:** High
**Def:** The baseline clinician role. Appears on the schedule grid, participates in picklists, has a pick-order position.
**Actors:** staff member · **Feat:** FEAT-006 · **Ent:** ENT-007
**Ev:** 02-role §5 (largest single group; Show In Grid: Yes; often has a "Picks Excluded" value)
**Amb:** See TERM-008 — the word is overloaded.
**Disp:** **RETAIN** as a role value only.

#### TERM-012 · Role value — Locum
**SP:** Role: Locum · **Src:** "Locum" · **Class:** OBS · **Conf:** High
**Def:** Relief/temporary staff. Structurally first-class: a distinct Contacts filter, a distinct vacation-roster category, and its own lockout-hours rule.
**Actors:** locum staff, scheduler · **Feat:** FEAT-006, FEAT-021 · **Ent:** ENT-007
**Ev:** 01-app ADM-05, VAC-02, CON-01, ADM-01 ("Locum Lockout Hours"); 02-role §5
**Amb:** Some Locum rows have `Show In Grid: No`, others `Yes` — the determining rule is **UNRESOLVED** (unresolved-questions #26). Also unclear whether "Locum" in the vacation roster is the same concept as the Access Level (unresolved-questions, Phase 1 §VAC-02 — most likely yes).
**Disp:** **RETAIN.** Locum is a genuine domain concept worth preserving, distinct from a simple "part-time" flag.

#### TERM-013 · Role value — View
**SP:** Role: Viewer · **Class:** OBS · **Conf:** Med · **Src:** "View"
**Def:** A read-only role. Observed rows frequently lack phone numbers, have `Show In Grid: No`, and several are clearly shared/functional accounts rather than individuals.
**Actors:** read-only user · **Feat:** FEAT-006 · **Ent:** ENT-007
**Ev:** 02-role §5, §6
**Amb:** Exact capability set is **UNRESOLVED** — no View-level session was ever available (unresolved-questions #1, #19).
**Disp:** **RENAME** to "Viewer" (a noun naming the actor, consistent with the other role values, rather than a verb).

#### TERM-014 · Role value — Telecom
**SP:** Role: Notification-Only · **Src:** "Telecom" · **Class:** OBS · **Conf:** Med
**Def:** Accounts that receive on-call/admin notifications but never appear on the schedule and never pick. Observed almost uniformly with `Admin Emails: Yes`, `Show In Grid: No`, and no phone numbers.
**Actors:** hospital switchboard / telecom staff · **Feat:** FEAT-006, FEAT-040 · **Ent:** ENT-007
**Ev:** 02-role §5 (a large cluster on one group's roster, essentially absent on the other)
**Amb:** "Telecom" is a tenant-specific job title, not a generic product concept. Its capability set is **UNRESOLVED**.
**Disp:** **RENAME** to a function-describing term. SchedulePoint should express this as a *notification-recipient* role rather than borrowing one customer's departmental name.

#### TERM-015 · Role value — Scheduler
**SP:** Role: Scheduler · **Src:** "Scheduler" · **Class:** OBS · **Conf:** High
**Def:** The operational administrator: runs picklists, approves vacation, configures the schedule, manages users. This is the role held by the account used throughout all twelve research phases.
**Actors:** scheduler · **Feat:** FEAT-006 · **Ent:** ENT-007
**Ev:** 02-role §5, §8 (every capability directly exercised or reached)
**Amb:** The vacation setting "Approval Required **By Scheduler**" names this role explicitly in business copy, confirming it is the approval authority.
**Disp:** **RETAIN.**

#### TERM-016 · Role value — Genius
**SP:** Role: Administrator · **Src:** "Genius" · **Class:** OBS · **Conf:** Low
**Def:** The rarest role (2–3 rows per group), assigned to the most senior/central accounts including group scheduling-office shared mailboxes.
**Actors:** senior administrator · **Feat:** FEAT-006 · **Ent:** ENT-007
**Ev:** 02-role §5
**Amb:** **UNRESOLVED whether Genius carries any capability beyond Scheduler** — no Genius session was available and no capability gap was found (unresolved-questions #22). Its position above Scheduler is inferred from rarity and assignment pattern only.
**Disp:** **RENAME.** "Genius" is a vendor-branding term with no descriptive meaning. SchedulePoint should name the top tier for what it does.

#### TERM-017 · Permission flag
**SP:** Permission flag · **Src:** "Admin Emails", "Picklist Admin", "Show In Grid", "Proxy Locked", "Notification Locked", "Start Tour", "Picks Excluded", "Action Time" · **Class:** OBS · **Conf:** High
**Def:** Independent per-membership booleans/values layered on top of the Role, varying independently of it.
**Actors:** administrator · **Feat:** FEAT-006 · **Ent:** ENT-006, ENT-008
**Ev:** 01-app ADM-05; 02-role §5
**Amb:** **Contradiction C-02 (BLOCKING).** The reviewing account had `Picklist Admin: No` yet retained full Picklist Manager, Dashboard, and picklist-admin access throughout the entire research effort. Either the flag grants something narrower than its name implies, it is vestigial, or enforcement lives elsewhere. **This is unresolved and must not be copied.**
**Disp:** **SPLIT and redesign.** These eight flags mix at least four different concepts (permission grants, display preferences, admin locks, and scheduling parameters). SchedulePoint must not ship a flag whose name does not match a tested capability — see QA-AUTH-007, C-02.

#### TERM-018 · Picklist Admin *(flag)*
**SP:** *(pending redesign)* · **Src:** "Picklist Admin" · **Class:** UNR · **Conf:** Low
**Def:** A per-user Yes/No flag whose actual granted capability was never established.
**Actors:** administrator · **Feat:** FEAT-006, FEAT-030 · **Ent:** ENT-008
**Ev:** 02-role §5; unresolved-questions #20; 11-edge-cases C-02, QA-AUTH-007
**Amb:** **This is contradiction C-02 in its most concrete form.** See TERM-017.
**Disp:** **AVOID copying.** SchedulePoint must design picklist administration permissions from first principles. **Blocking — pending product-owner decision.**

#### TERM-019 · Proxy / Pick Proxy
**SP:** Proxy Authorization · **Src:** "Pick Proxy", "Proxy Locked" · **Class:** OBS · **Conf:** Med
**Def:** A delegation letting one user act for, or receive notifications on behalf of, another during picklist execution.
**Actors:** staff member, delegate · **Feat:** FEAT-034 · **Ent:** ENT-010
**Ev:** 01-app PL-02; 03-user WF-22; 07-picklist §2
**Amb:** **UNRESOLVED whether a proxy actually *picks* on behalf of the absent staff member, or merely *receives their notifications*.** The screen is titled "Pick List Notification Settings," which suggests notifications only — but the feature is named "Pick Proxy," which suggests picking. These have very different authorization consequences. Eligible-proxy scope is also unresolved (#27).
**Disp:** **SPLIT** into two explicitly-named capabilities (notification delegation vs. acting authority). SchedulePoint must not ship an ambiguous "proxy" that silently confers more power than the user expected.

#### TERM-020 · Functional account
**SP:** Functional Account · **Src:** *(none — inferred from roster rows)* · **Class:** INF · **Conf:** High
**Def:** A shared, non-person account representing a desk, office, or role (e.g. a department mailbox, an OR reception point).
**Actors:** shared teams · **Feat:** FEAT-005 · **Ent:** ENT-004
**Ev:** 02-role §6
**Amb:** The source models these as ordinary Users, distinguishable only by their name/email pattern — there is no flag marking an account as non-person.
**Disp:** **INTRODUCE** as an explicit account type. Conflating shared mailboxes with individual identities has real audit and privacy consequences (an audit entry attributed to a shared account names nobody).

#### TERM-021 · Placeholder slot
**SP:** Placeholder Assignee · **Src:** *(none — inferred; e.g. "Locum TBA"-style rows)* · **Class:** INF · **Conf:** High
**Def:** A stand-in identity occupying a schedulable position that has not yet been filled by a named person.
**Actors:** scheduler · **Feat:** FEAT-005 · **Ent:** ENT-004
**Ev:** 02-role §6 (at least two sequentially-numbered placeholder Locum accounts, plus a "day off" placeholder)
**Amb:** Like functional accounts, these are ordinary User rows with no distinguishing flag. The source's "staff member" entity is effectively polymorphic: real person, shared contact point, or unfilled slot.
**Disp:** **INTRODUCE** as an explicit type. See 02-role §6's own recommendation that a clean-room design decide this deliberately rather than inherit it.

---

## C. Shifts, assignments, and the schedule

#### TERM-022 · Shift Type
**SP:** Shift Type · **Src:** "Shift", "Shift Definition" · **Class:** OBS · **Conf:** High
**Def:** A catalogue entry defining a kind of work: full name, short code, start/end time, and three independent flags (on-call, manual-only, stipend-eligible) plus a daily-pick flag.
**Actors:** administrator · **Feat:** FEAT-010 · **Ent:** ENT-011
**Ev:** 01-app ADM-07; 05-engine ADM-07
**Amb:** The source says "Shift" for both the *type* (catalogue entry) and the *instance* (a particular person working a particular day). See TERM-023.
**Disp:** **SPLIT** from TERM-023. Shift Type is the template; Assignment is the instance.

#### TERM-023 · Assignment
**SP:** Assignment · **Src:** "Shift", "Work", "Pick" (all used for the instance) · **Class:** OBS · **Conf:** High
**Def:** A specific Staff Member scheduled to a specific Shift Type on a specific date within a specific Group.
**Actors:** all · **Feat:** FEAT-011, FEAT-012 · **Ent:** ENT-014
**Ev:** 01-app SCH-02/03/04; 04-master §3, §4; 10-technical API-05/06 (`/api/works/…`)
**Amb:** **Three source words for this one concept** — the grid calls it a shift, the API calls it "works", the picklist calls it a pick. Additionally, the *shift* and the *fairness credit* for an assignment are **independently movable** (see TERM-041) — meaning "who works it" and "who is scored for it" can legitimately differ.
**Disp:** **MERGE** the three source words into "Assignment", and keep it strictly separate from Shift Type (TERM-022) and from Credit (TERM-041). **This separation is a hard structural requirement** — see 14-domain-model.md ENT-011/ENT-014.

#### TERM-024 · Staff Group
**SP:** Staff Group · **Src:** "Staff Group" · **Class:** OBS · **Conf:** High
**Def:** A named subset of staff used to scope eligibility and rules.
**Actors:** administrator · **Feat:** FEAT-013 · **Ent:** ENT-012
**Ev:** 01-app ADM-06; 05-engine §1
**Amb:** Easily confused with Shift Group (TERM-025) — one groups *people*, the other groups *shift codes*. The source names them near-identically.
**Disp:** **RENAME** to something unmistakable (e.g. "Staff Pool") to break the Staff-Group/Shift-Group collision. **SP-REC — pending approval.**

#### TERM-025 · Shift Group
**SP:** Shift Group · **Src:** "Shift Group" · **Class:** OBS · **Conf:** High
**Def:** A named bundle of Shift Types used for two distinct purposes: fairness weighting, and as the target of a grouped "request off" (e.g. "Request off All Calls").
**Actors:** administrator, staff member · **Feat:** FEAT-014, FEAT-020 · **Ent:** ENT-013
**Ev:** 01-app ADM-08; 05-engine §1; 10-technical API-11 (`allowRequest=true` is a real server-side filter)
**Amb:** Serves two unrelated purposes (scoring and request-targeting) through one entity. Also collides nominally with Staff Group (TERM-024).
**Disp:** **RETAIN** the concept but consider splitting its two roles. See TERM-024 for the naming collision.

#### TERM-026 · Master Schedule
**SP:** Schedule · **Src:** "Master Schedule" · **Class:** OBS · **Conf:** High
**Def:** The organization-wide grid of assignments across staff and dates for a Group, viewable three ways (by date, by staff, by shift).
**Actors:** all · **Feat:** FEAT-011 · **Ent:** ENT-014, ENT-016
**Ev:** 01-app SCH-02/03/04; 04-master (entire report)
**Amb:** "Master" implies a single authoritative copy — but the source's Build pipeline produces versioned outputs that feed it, and the grid itself carries a `buildState` parameter, so what is displayed is really *the current published state*. There is **no rollback or unpublish control anywhere in the product** (unresolved-questions #40).
**Disp:** **RENAME** to "Schedule", with an explicit Schedule Version concept (TERM-029) behind it. See ENT-016.

#### TERM-027 · Schedule Period
**SP:** Schedule Period · **Src:** *(implicit — a Build's date range)* · **Class:** INF · **Conf:** Med
**Def:** The bounded date range a schedule is planned and published for (observed spans ≈166–182 days, i.e. half-year blocks).
**Actors:** scheduler · **Feat:** FEAT-015 · **Ent:** ENT-015
**Ev:** 05-engine ADM-02 (Build Start/End dates, Monday/Sunday constrained)
**Amb:** The source has no standalone "period" entity — the range is a property of a Build. Multiple Builds share the same range (the Step 1/2/3/4 chain), so period and build are many-to-one.
**Disp:** **INTRODUCE** as a first-class entity, so that several build attempts and several published versions can all reference one period.

#### TERM-028 · Publication
**SP:** Publication · **Src:** "Publish" (a Build pipeline stage) · **Class:** OBS · **Conf:** Med
**Def:** The act of making a generated schedule live and visible to staff.
**Actors:** scheduler · **Feat:** FEAT-018 · **Ent:** ENT-016
**Ev:** 01-app ADM-02; 05-engine §3
**Amb:** **The word "Publish" is used for two entirely different operations in the source**: (a) the Build pipeline's Publish stage, and (b) the literal string a scheduler must *type* to confirm the irreversible Vacation→Master Schedule transfer. These are unrelated actions with very different blast radii. Publish's actual effect was never observed (never clicked).
**Disp:** **SPLIT.** Reserve "Publish" for schedule publication only; name the vacation operation something else entirely (see TERM-037).

#### TERM-029 · Schedule Version
**SP:** Schedule Version · **Src:** *(none — no versioning of published output exists)* · **Class:** SP-REQ · **Conf:** n/a
**Def:** An immutable snapshot of a published schedule for a period, retained after superseding so history is never silently lost.
**Actors:** scheduler, auditor · **Feat:** FEAT-018, FEAT-019 · **Ent:** ENT-016
**Ev:** 04-master §8 (no rollback/unpublish control found); 05-engine §2 (Builds *are* retained historically, but published output is not versioned)
**Amb:** The source retains **build** history (sequential IDs for the same period) but provides no way to see, compare, or revert to a previously *published* state. Direct cell edits after publication leave an audit entry but no version.
**Disp:** **INTRODUCE.** This is one of the architectural requirements carried into Phase 13: published schedules must be versioned and auditable, never silently overwritten.

#### TERM-030 · Lock / Unlock
**SP:** Lock · **Src:** "Lock", "Unlock", "Locked", "Unlocked" · **Class:** OBS · **Conf:** Med
**Def:** A freeze on a Build (and by extension its period) preventing further pipeline operations. A locked build shows only "Unlock".
**Actors:** scheduler · **Feat:** FEAT-018 · **Ent:** ENT-016, ENT-024
**Ev:** 01-app ADM-02; 05-engine §2; 07-picklist §1 (picklists have their own separate Locked/Unlocked toggle)
**Amb:** **Two independent lock concepts share one word:** Builds have a lock, and *picklists* have a separate lock. Whether a locked Build also blocks direct Master Schedule cell edits is **UNRESOLVED** (unresolved-questions #38, deliberately untested).
**Disp:** **SPLIT** by qualifying each (Schedule Lock vs. Picklist Lock). Never use bare "Lock".

---

## D. Schedule generation and rules

#### TERM-031 · Build
**SP:** Schedule Build · **Src:** "Build" · **Class:** OBS · **Conf:** High
**Def:** A named, dated, versioned generation run that produces a schedule for a period, progressing through Setup → Planner → Build → Fix Picks → Publish → Lock.
**Actors:** scheduler · **Feat:** FEAT-016 · **Ent:** ENT-024
**Ev:** 01-app ADM-02; 05-engine ADM-02 (full Setup field inventory)
**Amb:** "Build" names both the **whole pipeline object** and **one stage within it** (the third button). Genuinely confusing in the source's own UI.
**Disp:** **RENAME** the object to "Schedule Build" and the stage to "Generate", eliminating the self-reference.

#### TERM-032 · Progressive Build
**SP:** Build Chain · **Src:** "Progressive Build" · **Class:** OBS · **Conf:** Med
**Def:** A multi-select referencing prior builds, letting one build extend another — the mechanism behind the "Step 1/2/3/4" naming seen throughout the Builds list.
**Actors:** scheduler · **Feat:** FEAT-016 · **Ent:** ENT-024
**Ev:** 05-engine ADM-02
**Amb:** Whether chained builds *merge* results or *supersede* them is **UNRESOLVED** — never run.
**Disp:** **RENAME** for clarity; retain the capability. Iterative, reviewable generation is a genuine strength worth preserving.

#### TERM-033 · Planner
**SP:** Planner · **Src:** "Planner" · **Class:** UNR · **Conf:** Low
**Def:** A pipeline stage between Setup and Build, apparently deriving a cached plan from Setup's configuration.
**Actors:** scheduler · **Feat:** FEAT-016 · **Ent:** ENT-024
**Ev:** 05-engine §"Master checklist" — clicking Planner produced no visible navigation; not forced via "Save & Generate Planner" (unresolved-questions #41)
**Amb:** **Largely UNRESOLVED.** The only firm evidence is a Setup-screen warning: *"Generate Planner if you make changes to staff or shifts"* — implying the Planner caches Setup state rather than reading it live at build time.
**Disp:** **Defer.** Do not design a Planner stage into SchedulePoint on this evidence. If a staging step is needed, design it deliberately.

#### TERM-034 · Fix Picks
**SP:** *(pending redesign)* · **Src:** "Fix Picks" · **Class:** UNR · **Conf:** Low
**Def:** A manual-correction stage between automated generation and publication.
**Actors:** scheduler · **Feat:** FEAT-016 · **Ent:** ENT-024
**Ev:** 01-app ADM-02 (button label only — never clicked)
**Amb:** **UNRESOLVED entirely** — its screen was never opened. Name implies repairing solver output before publishing.
**Disp:** **Defer**; the *concept* (a human review-and-correct step before publication) is sound and should be designed deliberately as part of the schedule-review state machine (STM-002).

#### TERM-035 · Pattern Rule
**SP:** Pattern Rule · **Src:** "Pattern Rule" · **Class:** OBS · **Conf:** High
**Def:** A declarative spacing/fairness constraint scoped by shift or shift-group and by weekday: "when assigning X, apply a constraint to Y at offset N (or at Optimal Spacing), as a hard or weighted penalty."
**Actors:** administrator · **Feat:** FEAT-017 · **Ent:** ENT-021
**Ev:** 01-app ADM-10 (11 rules observed); 05-engine ADM-10 (full authoring form)
**Amb:** None significant — this is one of the best-evidenced concepts in the research.
**Disp:** **RETAIN.**

#### TERM-036 · Staff Rule
**SP:** Staff Rule · **Src:** "Staff Rule" · **Class:** OBS · **Conf:** High
**Def:** A named-individual constraint layered above Pattern Rules, capable of five THEN-actions: Assign, Penalty, Exclude, Linked, Staff-Shift.
**Actors:** administrator · **Feat:** FEAT-017 · **Ent:** ENT-022
**Ev:** 02-role ADM-11 (6 rules observed); 05-engine ADM-11 (full authoring form)
**Amb:** The tenant's six existing rules use only the simplest shape (`IF assigned THEN penalty`), but the authoring form reveals a **materially richer language** than any live rule exercises — including negation, Staff-Balance-conditioned conditions, direct assignment, and exclusion.
**Disp:** **RETAIN**, treating the observed simple examples as a floor rather than the ceiling of required expressiveness.

#### TERM-037 · Valid Group
**SP:** Position Restriction · **Src:** "Valid Group" · **Class:** OBS · **Conf:** Med
**Def:** A rule restricting which pick-order positions are legal for a given set of shift codes.
**Actors:** administrator · **Feat:** FEAT-017 · **Ent:** ENT-023
**Ev:** 05-engine ADM-09 (resolved a Phase 1 open question: Group One = shift codes, Group Two = pick positions)
**Amb:** The single observed instance was **unrestricted** (all 30 positions selected), so the restrictive case is structurally supported but never seen in effect (unresolved-questions #44). The name "Valid Group" describes nothing about what it does, and collides conceptually with Staff Group and Shift Group.
**Disp:** **RENAME.** Three entities named "…Group" that group entirely different things is a real comprehension hazard.

#### TERM-038 · Hard vs. Weight Penalty
**SP:** Hard Constraint / Weighted Preference · **Src:** "Hard Penalty", "Weight Penalty", "Hard (0)", "Linear (1000)" · **Class:** OBS · **Conf:** High
**Def:** The two enforcement modes for a rule: a non-negotiable constraint, or a numerically-scored preference the solver may trade off.
**Actors:** administrator · **Feat:** FEAT-017 · **Ent:** ENT-021, ENT-022
**Ev:** 05-engine ADM-10 (resolved via the authoring form's radio options)
**Amb:** The "Hard (0)" display convention is misleading — a weight of zero is meaningless for a true hard constraint; it is a display artifact, not a real weight.
**Disp:** **RENAME** to make the distinction self-evident and drop the meaningless zero.

#### TERM-039 · Optimal Spacing
**SP:** Optimal Spacing · **Src:** "Optimal Spacing" · **Class:** OBS · **Conf:** Med
**Def:** An engine-computed spacing strategy, offered as an alternative to a manually-specified day offset.
**Actors:** administrator · **Feat:** FEAT-017 · **Ent:** ENT-021
**Ev:** 05-engine ADM-10
**Amb:** The actual algorithm is **UNRESOLVED** — the UI exposes it as a named choice with no parameters, and no build was ever run.
**Disp:** **RETAIN** the concept; the algorithm must be designed independently (clean-room).

#### TERM-040 · Staff Shift FTE
**SP:** Staff Shift Eligibility · **Src:** "Staff Shift FTE" · **Class:** OBS · **Conf:** Med
**Def:** A per-staff, per-shift-type matrix of eligibility (Active Yes/No), a Max Shifts cap, and per-weekday quota columns.
**Actors:** administrator · **Feat:** FEAT-013 · **Ent:** ENT-011, ENT-006
**Ev:** 01-app ADM-03; 05-engine ADM-03
**Amb:** "FTE" (full-time equivalent) is a payroll term; this screen is really about eligibility and caps, not employment fraction.
**Disp:** **RENAME** — the source name actively misleads.

---

## E. Fairness, statistics, and balance

#### TERM-041 · Credit
**SP:** Credit · **Src:** "Credit", "Credits" · **Class:** OBS · **Conf:** High
**Def:** The fairness-scoring value attached to an assignment, **independently movable from the assignment itself**. Moving a shift (who works) is a distinct operation from moving a credit (who is scored).
**Actors:** scheduler · **Feat:** FEAT-012, FEAT-023 · **Ent:** ENT-017
**Ev:** 04-master §3.1 (the Display selector's Shifts/Credits split — a major Phase 5 finding); 01-app ADM-04
**Amb:** Subtle and easy to miss; it explains why Shift Statistics separately reports "Credits" and "Actual Shifts."
**Disp:** **RETAIN and model explicitly.** This is one of the genuinely sophisticated ideas in the source product and must survive into SchedulePoint as a first-class concept, not be flattened into the assignment.

#### TERM-042 · Actual Shifts vs. Target
**SP:** Actual vs. Target · **Src:** "Actual Shifts", "(Target)", "Credits" · **Class:** OBS · **Conf:** Med
**Def:** The fairness report's comparison of what a person was credited, what they were targeted for, and what they actually worked.
**Actors:** scheduler, staff member · **Feat:** FEAT-023 · **Ent:** ENT-017
**Ev:** 01-app ADM-04; 05-engine ADM-04
**Amb:** How Target is computed is **UNRESOLVED**.
**Disp:** **RETAIN** the three-way distinction.

#### TERM-043 · Staff Balance
**SP:** Staffing Balance · **Src:** "Staff Balance" · **Class:** OBS · **Conf:** High
**Def:** A per-day computed staffing-adequacy indicator: `Staff Available − Daily Picks − Operating Rooms`.
**Actors:** scheduler · **Feat:** FEAT-011 · **Ent:** ENT-014
**Ev:** 01-app SCH-02/03/04; 04-master §4 (formula confirmed via the editable modal)
**Amb:** Whether the three visible terms are the complete formula is **UNRESOLVED** (unresolved-questions #4). Notably, Staff Rules can *condition on* this value, making it an engine input as well as a display.
**Disp:** **RETAIN**, with the formula made explicit and configurable rather than hard-coded.

#### TERM-044 · Operating Rooms
**SP:** Operating Rooms · **Src:** "Operating Rooms", "OR Daily Defaults" · **Class:** OBS · **Conf:** Med
**Def:** A per-day count of rooms requiring staffing; an admin-editable demand input to Staff Balance, defaulted per weekday (including holidays) in Group Settings.
**Actors:** scheduler · **Feat:** FEAT-011 · **Ent:** ENT-014
**Ev:** 01-app ADM-01, SCH-02/03/04; 04-master §4
**Amb:** Domain-specific to operating-theatre scheduling. A generic product would call this a demand or capacity figure.
**Disp:** **RENAME** to a domain-neutral term (e.g. "Demand Units") to keep SchedulePoint applicable beyond surgical settings. **SP-REC — pending approval.**

#### TERM-045 · Stipend
**SP:** Stipend · **Src:** "Stipend" · **Class:** OBS · **Conf:** Med
**Def:** A Yes/No flag on a Shift Type marking it as attracting additional compensation; also the name of one report/export type.
**Actors:** administrator, finance · **Feat:** FEAT-010, FEAT-024 · **Ent:** ENT-011
**Ev:** 01-app ADM-07; 08-supporting SM-02 (confirmed to exist only as an export type — no dedicated screen)
**Amb:** Implies payroll integration, but no payroll or finance feature exists anywhere in the product.
**Disp:** **RETAIN** as a shift attribute; explicitly scope payroll integration **out** of the MVP.

---

## F. Requests and time off

#### TERM-046 · Request
**SP:** Request · **Src:** "Request", "Requests" · **Class:** OBS · **Conf:** Med
**Def:** A staff-initiated ask that a scheduler (or the engine) accommodate a scheduling preference.
**Actors:** staff member, scheduler · **Feat:** FEAT-020 · **Ent:** ENT-018
**Ev:** 01-app SCH-01, ADM-08; 03-user WF-08/09/10; 06-requests LC-01/LC-02
**Amb:** **Contradiction C-03.** Two request *shapes* coexist — vacation-week requests (fully mapped) and shift-group-scoped "OFF {X}" requests (LC-02, whose creation surface was **never located** after four phases of search). It is unresolved whether these are one entity with two views or two distinct entities, and whether the two withdrawal surfaces (My Requests' DELETE and the Vacation grid's Remove) act on the same record.
**Disp:** **MERGE into one entity with one lifecycle**, deliberately — see ENT-018 and C-03. SchedulePoint should model one Request with a type discriminator, not inherit an ambiguity.

#### TERM-047 · OFF request
**SP:** Time-Off Request · **Src:** "OFF {Shift Group}", "Request off All Calls." · **Class:** OBS · **Conf:** Med
**Def:** A request not to be assigned a given shift or shift group on a given date.
**Actors:** staff member · **Feat:** FEAT-020 · **Ent:** ENT-018
**Ev:** 03-user WF-10 (APPROVED history entries observed back to 2022); 01-app ADM-08 ("Allow Request" flag + "Request Off Text")
**Amb:** **Its creation surface was never found** — the standing gap of the requests family (unresolved-questions #16/#30/#47). Status history is well evidenced; creation is not.
**Disp:** **RETAIN** as a request type. Design the creation surface from scratch.

#### TERM-048 · ON request
**SP:** Availability Request · **Src:** *(none directly observed)* · **Class:** UNR · **Conf:** Low
**Def:** *Presumed:* a request **to be** assigned particular work — the positive counterpart of an OFF request.
**Actors:** staff member · **Feat:** FEAT-020 · **Ent:** ENT-018
**Ev:** 06-requests §"Master checklist" — listed as a topic, marked UNRESOLVED; no ON-shaped request was ever observed in any history
**Amb:** **No direct evidence this exists in the source at all.** It is included here because the research brief named it and because the Opportunity Board (TERM-051) partially serves the same need.
**Disp:** **Defer.** Do not assume the source supports this. If SchedulePoint wants positive availability requests, design them deliberately — do not present them as an observed source capability.

#### TERM-049 · Vacation
**SP:** Vacation · **Src:** "Vacation", "OFF" (the rendered shift code) · **Class:** OBS · **Conf:** High
**Def:** Approved extended time off, tracked in weekly units against an annual entitlement, within a bounded Vacation Block.
**Actors:** staff member, scheduler · **Feat:** FEAT-021 · **Ent:** ENT-019, ENT-020
**Ev:** 01-app VAC-01/02; 06-requests LC-01
**Amb:** Vacation is tracked in a **separate subsystem** from ordinary requests, with its own quota accounting, its own approval tool, and a one-way batch transfer into the schedule. It is not simply a request type.
**Disp:** **RETAIN** as a distinct subsystem, per the source's own structure — this separation is well-evidenced and reasonable.

#### TERM-050 · Vacation Block
**SP:** Vacation Period · **Src:** "Vacation Block", "Active vacation block" · **Class:** OBS · **Conf:** High
**Def:** The bounded date range (start must be a Monday, end a Friday) within which vacation requests, quotas, and approvals are tracked.
**Actors:** administrator · **Feat:** FEAT-021 · **Ent:** ENT-020
**Ev:** 01-app VAC-01/02
**Amb:** "Block" also colloquially means "to prevent", which is the opposite of its meaning here.
**Disp:** **RENAME** to "Vacation Period" for consistency with Schedule Period (TERM-027) and to remove the ambiguity.

#### TERM-051 · Vacation Grant / Avail / Weekly Quota
**SP:** Vacation Entitlement / Balance / Weekly Capacity · **Src:** "Grant", "Avail", "Weekly Quota", "Requested" · **Class:** OBS · **Conf:** High
**Def:** Three distinct numbers: the per-staff annual entitlement (Grant), their remaining balance (Avail), and the per-week org-wide headcount target (Weekly Quota) against which requests are counted.
**Actors:** staff member, scheduler · **Feat:** FEAT-021 · **Ent:** ENT-020
**Ev:** 01-app VAC-01/02
**Amb:** "Grant" reads as a verb (to grant leave) but is a noun (the entitlement). "Quota" is org-wide capacity, not a personal allowance — easily confused with Grant.
**Disp:** **RENAME all three.** The over-quota indicator is advisory only (it turns red but does not block approval) — an important, deliberate design choice worth preserving explicitly.

#### TERM-052 · Vacation Transfer
**SP:** Vacation Commit · **Src:** "TRANSFER", "TRANSFER VACATIONS TO MASTER SCHEDULE" · **Class:** OBS · **Conf:** High
**Def:** The batch, explicitly-irreversible operation writing approved vacation weeks into the live schedule as OFF assignments. Requires typing the literal word "PUBLISH" to confirm.
**Actors:** scheduler · **Feat:** FEAT-022 · **Ent:** ENT-019, ENT-014
**Ev:** 06-requests LC-01b — *"Please type PUBLISH into the box below to confirm writing vacations to the master schedule. It can NOT be undone."*
**Amb:** **Two naming problems at once:** the button says "TRANSFER" (which elsewhere in the domain means moving a shift between people — TERM-055) while the confirmation word is "PUBLISH" (which elsewhere means schedule publication — TERM-028). One operation borrowing two other concepts' names. Idempotency is **UNRESOLVED** (#45).
**Disp:** **RENAME decisively.** This is the highest-consequence single control found in the entire product and it must not share a name with two unrelated operations. The **type-to-confirm friction pattern itself is excellent and should be retained** for equivalently irreversible actions.

#### TERM-053 · Approval
**SP:** Approval · **Src:** "Approve", "Deny", "Approval Required By Scheduler", "Batch Approval" · **Class:** OBS · **Conf:** High
**Def:** A scheduler's decision on a pending request, available individually or in a date-range batch.
**Actors:** scheduler · **Feat:** FEAT-021 · **Ent:** ENT-025
**Ev:** 01-app VAC-01/02; 06-requests LC-01, LC-01a
**Amb:** **"Remove" and "Deny" coexist on the same modal** regardless of the entry's status, and their differing server effects are **UNRESOLVED** (unresolved-questions, WF-09). Whether approval triggers any notification is also unresolved (#50).
**Disp:** **RETAIN**, with Remove (withdrawal by the requester) and Deny (rejection by the approver) as explicitly distinct, separately-audited transitions.

---

## G. Shift marketplace

#### TERM-054 · Opportunity
**SP:** Opportunity · **Src:** "Opportunity", "POST OPPORTUNITY", "Opportunity Board", "moved as opportunity" · **Class:** OBS · **Conf:** Med
**Def:** A future assignment its holder has offered up for any eligible colleague to claim — a one-to-many give-away.
**Actors:** staff member · **Feat:** FEAT-025 · **Ent:** ENT-026
**Ev:** 01-app SCH-01; 03-user WF-11/12; 06-requests LC-03; 04-master §3.3 (audit-log wording confirms server-side terminology)
**Amb:** **The claim side was never observed** — every opportunity inspected belonged to the reviewing account itself, so only posting and retraction are evidenced. Race resolution when two people claim simultaneously is **UNRESOLVED** (#49).
**Disp:** **RETAIN.** Distinguish clearly from Offer (TERM-055).

#### TERM-055 · Offer / Swap / Transfer
**SP:** Shift Offer (1:1) · Shift Swap (mutual) · Shift Transfer (assignment change) · **Src:** "Swap Shift", "Swap Shifts", "TRANSFER", "reassigned" · **Class:** OBS · **Conf:** Low
**Def:** *Three genuinely different operations the source names inconsistently:* a directed one-to-one offer, a mutual exchange between two people, and an administrative reassignment.
**Actors:** staff member, scheduler · **Feat:** FEAT-026, FEAT-027 · **Ent:** ENT-027, ENT-028
**Ev:** 03-user WF-13 (Swap Shift modal: own-picks checklist + counterpart combobox); 06-requests LC-04; 04-master §3.3 ("reassigned to X by Y" audit entries)
**Amb:** **Substantially UNRESOLVED.** Whether a swap requires the counterpart's acceptance, a scheduler's approval, both, or neither was never determined (#32, #48) — the form was opened but never submitted, and no swap-shaped entry ever appeared in request history. Meanwhile "TRANSFER" is also the vacation-commit button (TERM-052).
**Disp:** **SPLIT into three explicitly-named operations.** This is one of the clearest cases in the glossary where the source's vocabulary must not be inherited. **Requires product-owner decision** on the acceptance/approval model — the research cannot settle it.

---

## H. Picklist system

#### TERM-056 · Picklist
**SP:** Picklist · **Src:** "Pick List", "Picklist", "Choose List" · **Class:** OBS · **Conf:** High
**Def:** A single day's turn-based draft: an ordered queue of participating staff plus a pool of work items, with a status lifecycle.
**Actors:** scheduler, staff member · **Feat:** FEAT-030 · **Ent:** ENT-029
**Ev:** 01-app PLM-01, PL-01, DASH-01; 07-picklist (entire report)
**Amb:** Spelled three ways across the UI ("Pick List", "Picklist", "PickList") plus a fourth name for the staff-facing view ("Choose List" — TERM-057). Only two statuses were ever observed (`ON HOLD`, `COMPLETED`); an active state necessarily exists but was **never seen** until the coverage audit confirmed one exists without opening it.
**Disp:** **MERGE** the spellings to one canonical "Picklist". This is the product's signature mechanism and deserves a single consistent name.

#### TERM-057 · Choose List
**SP:** My Picks *(staff-facing view of a Picklist)* · **Src:** "Choose List" · **Class:** OBS · **Conf:** High
**Def:** The staff-facing screen showing the user's picklist participation status across **all** their group memberships at once.
**Actors:** staff member · **Feat:** FEAT-031 · **Ent:** ENT-029
**Ev:** 01-app PL-01; 07-picklist §1; final-coverage-audit §6 (aggregate "pick N of M" progress state)
**Amb:** A *different name for the same underlying entity* viewed from the staff side — not a separate object. Its cross-group aggregation (showing both memberships without switching context) is a genuinely useful design worth keeping.
**Disp:** **RENAME** to make the view/entity relationship obvious. Do not model Choose List as its own entity.

#### TERM-058 · Pick
**SP:** Pick · **Src:** "Pick", "Nth Pick", "Daily Picks", "Picks" · **Class:** OBS · **Conf:** Med
**Def:** A single selection event within a picklist draft — one participant choosing one work item on their turn.
**Actors:** staff member · **Feat:** FEAT-032 · **Ent:** ENT-032
**Ev:** 01-app PLM-01, SCH-01; 07-picklist §2
**Amb:** **Heavily overloaded.** "Pick" means the *act* of selecting, the *resulting assignment*, the *ordinal position* in the queue ("5th Pick"), and — in "Daily Picks" — a *count* used in the Staff Balance formula. Four meanings.
**Disp:** **SPLIT** into Pick (the event), Pick Position (TERM-059), and Assignment (TERM-023). Never use bare "Pick" for a position.

#### TERM-059 · Pick Order / Pick Position
**SP:** Pick Position · **Src:** "pick order", "1st/2nd/…30th", "Pick Shifts", "Picks Excluded" · **Class:** OBS · **Conf:** High
**Def:** The numbered slot determining a participant's turn sequence in a draft. The count of available positions is a group-wide, **monotonically increase-only** setting (observed at 30).
**Actors:** scheduler, staff member · **Feat:** FEAT-030 · **Ent:** ENT-030
**Ev:** 01-app PLM-01; 05-engine ADM-07 ("Pick Shifts" modal: *"You may only increase the number of pick shifts... These may not be deleted in the future."*)
**Amb:** Pick order is displayed in Picklist Manager but **editable only via the Master Schedule** — an explicit on-screen note says so. The irreversible increase-only constraint is a notable architectural limitation.
**Disp:** **RETAIN** the concept; **do not** replicate the irreversible-growth constraint without a deliberate decision.

#### TERM-060 · Picks Excluded
**SP:** Position Exclusions · **Src:** "Picks Excluded" · **Class:** INF · **Conf:** Med
**Def:** A per-membership list/range of pick positions a staff member is skipped for (e.g. "2,3,4" or "1-3").
**Actors:** administrator · **Feat:** FEAT-006, FEAT-030 · **Ent:** ENT-008
**Ev:** 01-app ADM-05; 07-picklist §2
**Amb:** Meaning is **inferred from the field name and value shape**, never observed operating during a live draft.
**Disp:** **RETAIN** the capability; verify semantics before implementing (QA-PICK-007).

#### TERM-061 · Room
**SP:** Work Item · **Src:** "Room", "Add Room", "Work", "Work for `<date>`" · **Class:** OBS · **Conf:** Med
**Def:** An assignable unit of work in a picklist's pool — a specific operating room, location, or duty slot for that date, carrying a title, a procedure count, and a description.
**Actors:** scheduler, staff member · **Feat:** FEAT-030 · **Ent:** ENT-031
**Ev:** 07-picklist §0 (field set observed during the incident), §1
**Amb:** Called "Room" in the creation control but "Work" in the panel heading and the API. Also domain-specific — not all pickable work is a room.
**Disp:** **RENAME** to "Work Item" (generic), retaining Room as an optional attribute. **This is also the site of the research effort's only safety incident** — see TERM-062.

#### TERM-062 · Instant-commit "Add"
**SP:** *(anti-pattern — do not replicate)* · **Src:** "Add Room" · **Class:** OBS · **Conf:** High
**Def:** A control labelled "Add" that **immediately persists a live record on click**, with no draft state, no preview, and no confirmation.
**Actors:** scheduler · **Feat:** FEAT-030 · **Ent:** ENT-031
**Ev:** 07-picklist §0 (the documented safety incident — a real room was created and immediately deleted); 11-edge-cases QA-PICK-003, C-05
**Amb:** **Contradiction C-05** — nearly every other form in the product uses explicit Save/Cancel, making this control's behaviour internally inconsistent and genuinely unpredictable.
**Disp:** **AVOID — SOURCE DEFECT.** SchedulePoint must enforce a universal rule: no control labelled Add/New/Create persists anything before an explicit, separate Save. This is among the clearest "do not replicate" findings of the entire effort.

#### TERM-063 · Daily Assignment
**SP:** Daily Assignment Sheet · **Src:** "Daily Assignments", "Work for `<date>`", "Assigned Positions" · **Class:** OBS · **Conf:** High
**Def:** The operational, human-readable rundown of one day's finalized work — the output view of a completed picklist, tied to a specific picklist ID.
**Actors:** all staff · **Feat:** FEAT-033 · **Ent:** ENT-014
**Ev:** 01-app DA-01; 07-picklist §5
**Amb:** A *view* over assignments, not a separate entity, despite having its own screen and URL.
**Disp:** **RETAIN** as a named view. **Note:** this screen and the personal "Today's Shifts" panel are where clinical case detail appears — see TERM-070.

#### TERM-064 · Action Time / Alert Pick Time
**SP:** Turn Time Limit / Alert Threshold · **Src:** "Action Time", "Alert Pick Time", "Alert Average Pick Time" · **Class:** INF · **Conf:** Low
**Def:** *Presumed:* a per-user time budget for taking a turn, and org-level thresholds that trigger the Dashboard's audible alert when picking is slow.
**Actors:** administrator · **Feat:** FEAT-030, FEAT-035 · **Ent:** ENT-008, ENT-029
**Ev:** 01-app ADM-05 ("Action Time", uniform value, meaning unclear — #14), ADM-01 (the two Alert fields)
**Amb:** **Largely UNRESOLVED.** No timer UI was ever observed, because no live picklist was ever opened. Time pressure on picking is real (the escalation ladder exists) but its mechanics are not evidenced.
**Disp:** **Defer**; design deliberately. Note the accessibility consequence: timed workflows must be achievable via assistive technology (QA-A11Y-014).

---

## I. Notifications

#### TERM-065 · Notification Escalation Ladder
**SP:** Escalation Policy · **Src:** *(unnamed — the two rule tables on PL-02/ADM-01)* · **Class:** OBS · **Conf:** High
**Def:** An ordered list of `{minutes-after-trigger, channel-set}` steps that progressively escalates an unanswered notification across up to four channels.
**Actors:** staff member, administrator · **Feat:** FEAT-040 · **Ent:** ENT-035
**Ev:** 01-app PL-02, ADM-01; 07-picklist §3
**Amb:** The source never names this structure; it is simply an unlabeled pair of tables. Two-tier override (group default → per-user) is **inferred** from the "Load Defaults" button's existence, not directly tested.
**Disp:** **INTRODUCE** the name. The structure itself is well-evidenced and worth preserving.

#### TERM-066 · Mandatory Hours / Personal Hours
**SP:** Business Hours / Personal Hours · **Src:** "Mandatory Hours", "Personal Hours" · **Class:** OBS · **Conf:** High
**Def:** Two time windows with independently-configured escalation ladders — one org-defined, one user-adjustable — determining how aggressively a user may be contacted at a given time of day.
**Actors:** staff member, administrator · **Feat:** FEAT-040 · **Ent:** ENT-035
**Ev:** 01-app PL-02, ADM-01
**Amb:** "Mandatory" describes the *hours*, not the *notifications* — a reader may reasonably think it means "notifications you cannot opt out of."
**Disp:** **RENAME** the first for clarity; retain the two-window concept, which is a thoughtful piece of design (respecting off-hours while permitting urgent contact).

#### TERM-067 · Channel
**SP:** Notification Channel · **Src:** "Email", "SMS text", "Dial Mobile", "Dial Home" · **Class:** OBS · **Conf:** High
**Def:** A delivery medium for a notification. Four observed, including two distinct **voice-call** channels.
**Actors:** all · **Feat:** FEAT-040 · **Ent:** ENT-034
**Ev:** 01-app PL-01, PL-02, ADM-01
**Amb:** Voice-call channels imply telephony integration that is invisible in the UI and was never confirmed to work. Delivery status, failure, and retry behaviour are **completely UNRESOLVED** — no delivery log exists anywhere in the product (#53).
**Disp:** **RETAIN** the abstraction; treat voice channels as a post-MVP integration decision.

---

## J. Supporting concepts

#### TERM-068 · Audit / Provenance Log
**SP:** Audit Event · **Src:** *(unnamed — the per-cell change history)* · **Class:** OBS · **Conf:** High
**Def:** An immutable, timestamped, human-readable record of every change to a schedule cell, naming the actor and distinguishing self-service picklist actions (tagged `PLC`) from admin-driven ones.
**Actors:** scheduler, auditor · **Feat:** FEAT-012, FEAT-045 · **Ent:** ENT-040
**Ev:** 03-user WF-05a; 04-master §3.3, §11
**Amb:** **Scope is UNRESOLVED** — whether it captures every change type (e.g. Publish, Erase Master Schedule) or only cell-level moves is unknown (#36), as is whether staff can view their own cells' history (#37). No aggregate/queryable audit view exists anywhere.
**Disp:** **RETAIN and substantially extend.** The per-cell log is one of the best ideas in the source product; SchedulePoint should make it comprehensive, queryable, and role-appropriately visible.

#### TERM-069 · Calendar Feed
**SP:** Calendar Feed · **Src:** "Subscribe", `webcal://` · **Class:** OBS · **Conf:** High
**Def:** A per-user, token-authenticated iCalendar subscription URL exposing that user's personal schedule to external calendar clients.
**Actors:** staff member · **Feat:** FEAT-042 · **Ent:** ENT-037
**Ev:** 03-user WF-23 (structure documented, token never captured)
**Amb:** The observed URL carries the user's **email address and a long-lived bearer token in query-string parameters** — a real privacy/security concern (QA-SEC-005, QA-SEC-009). Token revocability and rotation are **UNRESOLVED** (#35).
**Disp:** **RETAIN** the capability; **redesign the mechanism** — tokens must be revocable, rotatable, scoped to one membership, and never carry PII in a URL.

#### TERM-070 · Clinical case detail
**SP:** *(excluded from MVP)* · **Src:** *(unnamed — case-level content on "Today's Shifts")* · **Class:** OBS · **Conf:** High
**Def:** Patient-identifiable clinical information (age indicators, procedure descriptions) surfaced on the personal daily view.
**Actors:** staff member · **Feat:** FEAT-033 · **Ent:** *(none — deliberately)*
**Ev:** 07-picklist §6 (presence confirmed; content never transcribed)
**Amb:** A scheduling product accumulating clinical data inherits clinical-system regulatory obligations without clinical-system controls.
**Disp:** **EXCLUDE from the MVP.** This is a carried-forward architectural requirement: no patient-level information in SchedulePoint's MVP unless explicitly approved. See QA-SEC-006, QA-PICK-017.

#### TERM-071 · Document / Document Category
**SP:** Document · Document Category · **Src:** "Documents", "Add Category", "UpLoad File" · **Class:** OBS · **Conf:** High
**Def:** A shared file repository organized by a per-group category tree.
**Actors:** all staff, administrator · **Feat:** FEAT-050 · **Ent:** ENT-038
**Ev:** 01-app DOC-01; 08-supporting SM-05 (confirmed: **no search or filter exists**)
**Amb:** Only "Upload Date" provenance exists — no uploaded-by, no versioning (#SM-05). Role-based category visibility is **UNRESOLVED**.
**Disp:** **RETAIN**, post-MVP. Add search and provenance, which the source lacks.

#### TERM-072 · Report / Report Definition
**SP:** Report · **Src:** "Create `<Type>` Report" (6 types: Schedule, Picklist, Stipend, Requests, DayXShift, On Call Schedule) · **Class:** OBS · **Conf:** Med
**Def:** A configurable, generated output document. Each type opens a configuration dialog before producing output — not an instant download.
**Actors:** scheduler · **Feat:** FEAT-024 · **Ent:** ENT-039
**Ev:** 09-responsive RA-12 (5 types found via hidden heading text); final-coverage-audit SM-11 (a 6th type), SM-12 (a separate "Sharing Statistics Report" with recipient targeting)
**Amb:** **Dialog internals remain UNRESOLVED for 4 of 6 types** — discovered passively, never opened.
**Disp:** **RETAIN** the configure-then-generate pattern (better than instant download). Design report definitions deliberately.

#### TERM-073 · Contacts Directory
**SP:** Directory · **Src:** "Contacts" · **Class:** OBS · **Conf:** High
**Def:** A searchable staff directory with bulk email/SMS capability.
**Actors:** all staff · **Feat:** FEAT-041 · **Ent:** ENT-004
**Ev:** 01-app CON-01; 08-supporting SM-03; final-coverage-audit SM-13 (full send-form field schema)
**Amb:** **Contradiction C-06.** Contacts consistently shows ~30–35% fewer rows than the Users admin table for the same group (66 vs. 94, and 61 vs. 103 in the other group) — an undocumented filter. Also exposes personal mobile, home phone, and personal email broadly (QA-SEC-014).
**Disp:** **RETAIN** with **field-level data minimisation** — the source's broad PII exposure should not be replicated.

#### TERM-074 · Tour
**SP:** *(exclude)* · **Src:** "Tour", "Start Tour" · **Class:** UNR · **Conf:** Low
**Def:** An intended guided product walkthrough.
**Actors:** new user · **Feat:** *(none)* · **Ent:** ENT-009
**Ev:** 01-app SYS-04; 08-supporting SM-07; 10-technical §3 (the `bootstraptour` library loads on every page but never fires); final-coverage-audit (structure unchanged)
**Amb:** Loaded on every page across twelve phases and **never once produced a visible effect**. Effectively dead code.
**Disp:** **EXCLUDE** from MVP. Onboarding, if built, should be designed fresh.

#### TERM-075 · Help
**SP:** Help · **Src:** "Help" · **Class:** OBS · **Conf:** Med
**Def:** Per-screen links to static PDF documentation.
**Actors:** all · **Feat:** *(none)* · **Ent:** *(none)*
**Ev:** 08-supporting SM-01 (Vacation → `ComingSoon.pdf` stub); final-coverage-audit SM-14 (Builds → a real, distinctly-named file; Staff Shift FTE → the same stub)
**Amb:** Inconsistently rolled out — at least one real document, at least two placeholder stubs. Neither file was ever opened.
**Disp:** **RETAIN** the concept; implement consistently (contextual help on every screen or none).

---

## Summary: terms requiring deliberate decisions

| Term | Issue | Decision needed from |
|---|---|---|
| TERM-003 Site | Conflated with Group in the source; may or may not need to be a first-class entity | Product owner |
| TERM-017/018 Permission flags, Picklist Admin | **C-02 (BLOCKING)** — flag does not match observed capability | Product owner + architecture |
| TERM-019 Proxy | Notification delegation vs. acting authority never distinguished | Product owner |
| TERM-046 Request | **C-03** — one entity with two views, or two entities? | Product owner |
| TERM-048 ON request | No evidence it exists in the source at all | Product owner |
| TERM-055 Offer/Swap/Transfer | Acceptance/approval model entirely unresolved | Product owner |
| TERM-024/025/037 the three "…Group" terms | Naming collision across three unrelated concepts | Product owner |
| TERM-044 Operating Rooms | Domain-specific; genericize or retain? | Product owner |
| TERM-064 Action Time | Meaning never established | Deferred — needs live picklist |

---

## Cross-references

- Feature IDs (`FEAT-###`) are defined in [13-feature-inventory.md](13-feature-inventory.md).
- Entity IDs (`ENT-###`) are defined in [14-domain-model.md](14-domain-model.md).
- State-machine IDs (`STM-###`) are defined in [15-state-machines.md](15-state-machines.md).
- QA case IDs (`QA-*`) and contradictions (`C-01`..`C-07`) are defined in [11-edge-cases-and-qa.md](11-edge-cases-and-qa.md).
- Hard requirements `SP-HR-1`..`SP-HR-6` are defined in [11-edge-cases-and-qa.md](11-edge-cases-and-qa.md) §11–§13 and carried into [16-research-completion.md](16-research-completion.md) §12.

**Term count: 75.** No term was created without at least one source-report reference or an explicit SP-REQ/SP-REC classification.
