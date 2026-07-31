# 17 — Public-Source Functionality-Gap Addendum

**Task:** targeted iSchedule.MD functionality-gap reconciliation, performed after Phase 13 consolidation and **before** architecture or implementation.
**Access date for all public sources: 2026-07-30.**

> **Product-name note.** The task brief for this addendum refers to the product as **SchedulePilot**. The repository (`schedulepoint-research`) and all sixteen preceding reports refer to it as **SchedulePoint**. This addendum uses **SchedulePoint** for corpus consistency and treats the two names as referring to the same product. **This is flagged as an open naming question, not silently resolved** — see PO-DEC-00.

---

## 1. Scope and method

**Purpose:** determine whether the consolidated research (46 features, 75 terms, 44 entities, 21 state machines, 175 QA cases) omits any *useful capability or user outcome* that iSchedule.MD provides. SchedulePoint may improve unsafe, inaccessible, inconsistent, outdated, or defective behaviour — but it must not silently drop the underlying capability.

**Public sources inspected (all 2026-07-30):**

| Source | Coverage |
|---|---|
| `https://ischedule.md/` | Full page text; six capability pillars; seven long-form product sections; **all 8 FAQ answers expanded and read in full**; testimonials; mission/statistics footer |
| `https://ischedule.md/ischedule.md.pricing.pdf` | Full text extracted (Flate-decoded); all editions, inclusions, integrations, fees, commitments, training terms |
| `https://ischedule.md/users/login` | Rendered page + passive DOM field inspection |
| `https://ischedule.md/users/forgotpassword` | Rendered page + passive DOM field inspection |

Other same-domain links found on the homepage were `mailto:` addresses, `/app`, and an external browser-vendor link — no further public informational pages exist.

**Authenticated corroboration** was deliberately narrow: five already-known-safe read-only screens were revisited **only** to check whether a specific public claim has a visible corresponding feature. No broad re-crawl was performed.

**Method note:** the FAQ answers were read via passive DOM inspection of the collapsed accordion panels rather than by clicking, which is both safer and guarantees completeness (all 8 panels captured, none dependent on a successful click).

**Safety:** no form was submitted; the "Try the Picklist", contact, login, and password-reset forms were never submitted. **The active production picklist was never opened.** No mutating action of any kind occurred. No credentials, tokens, cookie values, patient data, staff names, hospital customer names, or live identifiers appear in this report. Testimonial authors and their institutions are referenced only as `TESTIMONIAL_A`..`TESTIMONIAL_F`.

---

## 2. Classification key

Exactly one primary classification per claim.

| Code | Meaning |
|---|---|
| `AUTHENTICATED OBSERVATION` | Directly observed in the live application. **Includes the application's own public login/reset pages**, which are product surfaces rather than marketing copy — distinguished from claims *about* the product |
| `PUBLIC SOURCE CLAIM` | Asserted by a public marketing/pricing source. **Does not prove the feature exists in the current authenticated application** |
| `CORROBORATED` | Supported by **both** a public source and an authenticated observation |
| `INFERRED` | Reasonable conclusion, not directly confirmed |
| `UNRESOLVED` | Cannot be determined from available evidence |
| `POSSIBLY LEGACY` | Reason stated. Never used merely because a feature was not found |
| `SOURCE CONTRADICTION` | Public claim and authenticated observation conflict |
| `SCHEDULEPOINT DECISION REQUIRED` | Product semantics that cannot be derived safely |
| `SANDBOX TEST REQUIRED` | Needs controlled state changes, multiple users, delivery destinations, or concurrency |
| `EXTERNAL SPECIFICATION REQUIRED` | Vendor/integration behaviour the website cannot establish |

**Production treatment** (one per capability):
`REQUIRED FOR PRODUCTION` · `REQUIRED PLATFORM CAPABILITY WITH OPTIONAL CONNECTOR` · `ADMINISTRATIVE FALLBACK OR OVERRIDE` · `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` · `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR RELEASE`

> **Standing rule applied throughout:** "post-MVP" is a *sequencing* decision, never a reason to drop a source capability from the finished production product. No capability below is recommended for exclusion because it is difficult, unobserved, or dependent on an external integration.

---

## 3. Public evidence register

**Field key:** **Src** = source + section · **Claim** (paraphrased) · **Class** · **Maps to** = existing research IDs · **Treatment**.

### 3.1 Scheduling engine and workforce rules

#### PUB-001 · Pattern-based engine generates months of schedule in seconds
**Src:** homepage, "Powerful" pillar · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** A pattern-based system handles complex schedules and generates months of schedule in seconds, using algorithms the vendor claims are unique.
**Maps to:** FEAT-016, FEAT-017, ENT-021, ENT-024, STM-001 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-002 · Automated schedule generation is the primary scheduling mechanism
**Src:** homepage, "Create" / "Building Schedule" · **Class:** `CORROBORATED`
**Claim:** Complex schedules are built within seconds at the touch of a button; the product's central value proposition is automated generation, not manual entry.
**Auth:** the Builds pipeline (Setup→Planner→Build→Fix Picks→Publish→Lock) exists and was documented in full.
**Maps to:** FEAT-016, STM-001, ENT-024 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** this is the single most consequential reconciliation finding — see §7 C-08 and §9.

#### PUB-003 · Target-percentage rules
**Src:** homepage FAQ "What are examples of your rules?"; "It's Personal" · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** Rules express per-physician target percentages (e.g. one physician at 80%, another at 60%); the product "fairly balances staff that work 60%, 80% or 100%".
**Maps to:** FEAT-013, FEAT-017, ENT-011, ENT-022 · **Gap:** no explicit *work-percentage* field was found on the roster; Staff Shift FTE holds per-weekday quotas and Max Shifts, from which a percentage may be derived. **See GAP-01.** · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-004 · Staff FTE varies by day of week
**Src:** FAQ "What are examples of your rules?" · **Class:** `CORROBORATED`
**Claim:** A named subgroup takes a given call type only on Monday/Tuesday/Wednesday, at differing percentages per physician.
**Auth:** Staff Shift FTE (ADM-03) provides per-shift-type, per-weekday quota columns (All, Mon–Sun, Hol) plus Active and Max Shifts.
**Maps to:** FEAT-013, ENT-011, ENT-006 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-005 · Maximum assignment counts per staff member
**Src:** FAQ rules example ("maximum of 5 shifts") · **Class:** `CORROBORATED`
**Auth:** "Max Shifts" column on Staff Shift FTE.
**Maps to:** FEAT-013, ENT-011 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-006 · Linked shifts
**Src:** FAQ rules example; "Powerful"; TESTIMONIAL_D ("complex linked shifts, which can be easily changed") · **Class:** `CORROBORATED`
**Claim:** Whoever works shift A on one day works shift B on another (e.g. Friday-night call → Sunday daytime OR).
**Auth:** Staff Rule Setup exposes a **`Linked`** THEN-action referencing another shift with its own offset.
**Maps to:** FEAT-017, ENT-022, STM-001 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-007 · Assigned-by-template / alternating-week assignment
**Src:** FAQ rules example ("Week one … Monday, Wednesday and Friday; week two … Monday and Wednesday") · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** Recurring multi-week rotation templates.
**Maps to:** FEAT-017, ENT-021 · **Gap:** **no template or alternating-week authoring surface was ever located.** Pattern Rules express spacing and offsets, not repeating multi-week templates. **See GAP-02.** · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-008 · Pattern-matching rules (no two consecutive weekend calls)
**Src:** FAQ rules example · **Class:** `CORROBORATED`
**Auth:** Pattern Rules (ADM-10) with weekday scoping and day offsets; 11 live rules observed including weekend-specific spacing.
**Maps to:** FEAT-017, ENT-021 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-009 · Optimal call spacing algorithm
**Src:** homepage hero; "Create"; FAQ competitors · **Class:** `CORROBORATED`
**Auth:** Pattern Rule Setup offers "Optimal Spacing" as a named offset mode, distinct from a manual day offset.
**Maps to:** TERM-039, FEAT-017, ENT-021 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** the algorithm itself is **UNRESOLVED** and must be designed clean-room.

#### PUB-010 · Staff-specific conditional rules incl. staffing-balance conditions
**Src:** FAQ rules example ("If the physician being assigned ORCALL likes 16-hour call **and staffing balance is +1**, then assign OFF before ORCALL") · **Class:** `CORROBORATED`
**Auth:** Staff Rule Setup exposes an `AND Staff Balance [operator] [value]` compound condition and a `Not` negation toggle.
**Maps to:** FEAT-017, ENT-022, TERM-043 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** the public example also implies a **staff *preference* attribute** ("likes 16-hour call") with no observed storage field. **See GAP-03.**

#### PUB-011 · Backup-call pairing
**Src:** FAQ rules example ("When Dr. X is on ORCALL, schedule Dr. Y on Backup Call") · **Class:** `CORROBORATED`
**Auth:** Staff Rule Setup's `Assign` and `Staff-Shift` THEN-actions.
**Maps to:** FEAT-017, ENT-022 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-012 · Picklist balanced by work percentage; locums excluded from specified pick positions
**Src:** FAQ rules example ("Equally balance the picklist by work percentage and exclude locum physicians from picks 1,2,3 and 4") · **Class:** `CORROBORATED`
**Auth:** per-membership `Picks Excluded` field holding a list/range of pick positions; Locum is a first-class Access Level.
**Maps to:** TERM-060, TERM-012, FEAT-006, FEAT-030, ENT-008, ENT-030 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** confirms `Picks Excluded` semantics, previously **INFERRED** from the field name alone.

#### PUB-013 · Progressive build around fixed manual assignments
**Src:** FAQ "There is part of our schedule that must be done by hand…" · **Class:** `CORROBORATED`
**Claim:** Build in as many stages as desired; hand-assign shifts, then have the engine build around them; optionally circulate a partial schedule, collect hand assignments, then complete generation.
**Auth:** Build Setup exposes a `Progressive Build` multi-select chaining prior builds; the "Step 1/2/3/4" naming convention appears throughout the Builds list.
**Maps to:** TERM-032, FEAT-016, ENT-024, STM-001 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** **"circulate a partial schedule for review, then continue generating" is a distinct workflow with no observed surface.** See GAP-04.

#### PUB-014 · Custom rules on request
**Src:** FAQ rules example ("If you can think it, we can build it!") · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** Arbitrary custom rules are implemented by the vendor per customer.
**Maps to:** FEAT-017 · **Treatment:** `SCHEDULEPOINT DECISION REQUIRED` — implies bespoke per-tenant rule development as part of the service model. **See PO-DEC-05.**

#### PUB-015 · Previous-statistics continuity across schedule periods
**Src:** "Keep it Fair" ("built using previous statistics to balance work over longer time frames"); TESTIMONIAL_A ("uses historical call data") · **Class:** `CORROBORATED`
**Auth:** Build Setup: `Use Previous Schedule Statistics`, previous-statistics date range, `Days of previous schedule`, and an explicit "do NOT overlap dates" validation note.
**Maps to:** FEAT-016, ENT-024, QA-SCH-007 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-016 · Scheduling planner and workbench verify schedule quality; identify conflicts quickly
**Src:** "Powerful"; "Create"; "Scheduling Workbench" heading; pricing PDF (standard edition inclusion) · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** A planner and workbench let the scheduler instantly verify the quality of the produced schedule and identify conflicts and outlying statistics quickly.
**Maps to:** FEAT-016, FEAT-023, ENT-025b, ENT-026b, STM-002 · **Gap:** **the Planner stage never rendered a screen and Fix Picks was never opened.** No conflict-detection or build-quality view was ever observed. **See GAP-05 — this is the largest engine-side gap.** · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-017 · Build performance: ~2,700 cells in as little as 5 seconds
**Src:** FAQ "How long does it take to build a schedule?" · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** A 30-staff group with multiple shifts and calls generates 3 months (~2,700 cells) in as little as 5 seconds.
**Maps to:** FEAT-016, QA-PERF-008 · **Treatment:** `REQUIRED FOR PRODUCTION` — adopt as a **benchmark target**, not an inherited guarantee. **See SBX-031.**

#### PUB-018 · Scale: 30+ staff and 10+ locums, variable FTE, skill sets, multiple call types
**Src:** FAQ "Will this work for my group?"; TESTIMONIAL_D ("30 staff and 6 locums") · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-013, ENT-006, ENT-012 · **Gap:** **"skill sets" has no dedicated representation** — see GAP-06. · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-019 · Usable by any healthcare group, not only anaesthesia
**Src:** FAQ "Will this work for my group?" · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** TERM-009, TERM-044 · **Treatment:** `SCHEDULEPOINT DECISION REQUIRED` — supports the glossary's recommendation to genericize domain-specific terms (e.g. "Operating Rooms"). **See PO-DEC-06.**

### 3.2 Requests, vacation, opportunities, swaps

#### PUB-020 · Staff shift requests approved or denied by the scheduler
**Src:** "Create"; "It's Personal" · **Class:** `CORROBORATED`
**Auth:** My Requests panel with full status history; vacation approve/deny surfaces.
**Maps to:** FEAT-020, ENT-018, ENT-025, STM-005 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-021 · Request types: No Call, days off, and *request to be assigned* certain shifts
**Src:** "It's Personal" ("shift requests for upcoming schedules like No Call, days off or request to be assigned certain shifts") · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** TERM-047, TERM-048, FEAT-020, ENT-018, STM-005 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note — important:** this is the **first positive evidence that a genuine ON request (positive availability request) exists.** Phase 13 recorded TERM-048 as having *no* observed source evidence and recommended deferring it. **This public claim materially changes that** — see AMD-04. It also names **"No Call"** as a distinct request type not previously catalogued. **See GAP-07.**

#### PUB-022 · Vacation module with scheduler review
**Src:** FAQ "Can you help with vacation planning?" · **Class:** `CORROBORATED`
**Maps to:** FEAT-021, ENT-019, ENT-020, STM-007 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-023 · Two vacation allocation modes: granted weeks with weekly quotas, **or** open-vacation mode
**Src:** FAQ vacation answer · **Class:** `CORROBORATED`
**Auth:** Vacation Settings exposes `Open Vacation Mode` (Yes/No), per-staff `Vacation Grant`, and a per-week `Weekly Vacation Quota` table.
**Maps to:** TERM-050, TERM-051, FEAT-021, ENT-020, ENT-021b · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** confirms the two modes are a deliberate, documented product choice rather than incidental configuration.

#### PUB-024 · Opportunity board with **automatic email fan-out to all group members**
**Src:** "It's Personal" ("post shifts to the opportunity board and **automatically notify all group members by email**"); TESTIMONIAL_C · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-025, ENT-026, STM-008, QA-OPP-006 · **Gap:** the research recorded opportunity notification as **UNRESOLVED** (#33). This public claim asserts automatic email fan-out to *all group members*. **Recipient rules, opt-outs, and eligibility filtering remain unobserved.** **See GAP-08.** · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-025 · Staff take preference over locum physicians for extra work
**Src:** "It's Personal" ("rules that allow staff members preference over locum physicians in picking up this extra work") · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** TERM-012, FEAT-025, ENT-026 · **Gap:** **no such preference rule was ever observed.** This is a distinct eligibility/priority mechanism on opportunity claiming. **See GAP-09.** · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-026 · Staff make their own schedule changes; scheduler may review before finalisation
**Src:** "Shift Changes" · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** Staff make changes directly; these **can be reviewed by the scheduler before they are finalized**, making staff accountable and reducing scheduler workload.
**Maps to:** FEAT-025, FEAT-026, ENT-025, ENT-027, ENT-028, STM-009, STM-010, STM-011 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** this is the **clearest public evidence yet on the swap/offer approval model** that Phase 13 left entirely undecided (STM-009/STM-010). It indicates review is **configurable/optional** ("can be"), not mandatory. **See AMD-05 and PO-DEC-02.**

#### PUB-027 · Detailed change log; affected staff updated by email
**Src:** "Shift Changes" ("detailed log of any changes made to the schedule and staff involved are updated by email") · **Class:** `CORROBORATED`
**Auth:** per-cell audit/provenance log with actor, action, timestamp, mechanism tag.
**Maps to:** FEAT-045, ENT-040, QA-SCH-015 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** the **email-to-affected-staff half is unobserved** — no notification surface for schedule changes was ever found. **See GAP-10.**

#### PUB-028 · Swap shifts
**Src:** "Personal" pillar; pricing PDF (standard edition inclusion); TESTIMONIAL_D ("give up or switch their call") · **Class:** `CORROBORATED`
**Maps to:** FEAT-026, ENT-027, ENT-028, STM-009, STM-010 · **Treatment:** `REQUIRED FOR PRODUCTION`

### 3.3 Picklist

#### PUB-029 · Mobile picklist replaces a paper list; staff choose work on their own device
**Src:** "Mobile Picklist"; "Picklist" pillar · **Class:** `CORROBORATED`
**Maps to:** TERM-056, FEAT-030, FEAT-031, FEAT-032, ENT-029, STM-012, STM-013 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-030 · **Paper picklist mode offered as a trial/entry edition**
**Src:** "Mobile Picklist" ("for groups not currently using a picklist … we do offer a paper version that can be trialed before upgrading"); pricing PDF edition **"Scheduling With Paper Picklist"** · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-030 · **Gap:** **no paper-picklist mode or edition switch was ever observed.** **See GAP-11.** · **Treatment:** `ADMINISTRATIVE FALLBACK OR OVERRIDE`

#### PUB-031 · **Manual room-entry picklist mode (no hospital integration)**
**Src:** pricing PDF, "Scheduling With Mobile Picklist" ("This is for groups that will **manually enter their room data**") · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-030, ENT-031 · **Gap:** confirms **three distinct picklist operating modes** (paper / mobile-manual / mobile-integrated). Only mobile-manual was partially observed. **See GAP-11.** · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-032 · **Hospital-integrated picklist mode with automated surgical-booking import**
**Src:** "Picklist" pillar; "Mobile Picklist"; pricing PDF "IT SETUP" · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** Direct integration with the hospital surgical booking system removes the need to enter room data; full automation requires this integration.
**Maps to:** FEAT-030, ENT-031 · **Gap:** **no import surface was ever located** (the Picklist Manager "Import" buttons are erase-and-resync confirmations, not file uploads). **See GAP-12.** · **Treatment:** `REQUIRED PLATFORM CAPABILITY WITH OPTIONAL CONNECTOR`

#### PUB-033 · Named integrations: ORSOS, Cerner/Surginet, Meditech
**Src:** pricing PDF ("Previously, we have integrated with ORSOS, Cerner and Meditech"); TESTIMONIAL_A ("integrate seamlessly with both ORSOS and Cerner Surginet platforms") · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** *(no existing feature)* → **proposed FEAT-055** · **Gap:** **external hospital integrations are entirely absent from the consolidated feature inventory.** **See GAP-12, AMD-01.** · **Treatment:** `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR RELEASE`

#### PUB-034 · Daily synchronisation scripts update the system securely
**Src:** TESTIMONIAL_A ("Daily scripts securely update ischedule.MD to ensure accurate list information without risking patient confidentiality") · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** proposed **FEAT-055** · **Treatment:** `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR RELEASE`
**Note:** implies a scheduled, recurring, push-or-pull sync job with its own failure modes. Direction, scheduling, retry, idempotency, and reconciliation are all **UNRESOLVED**.

#### PUB-035 · **All patient-identifying data removed prior to upload**
**Src:** "Mobile Picklist" ("All patient identifying data is removed prior to upload") · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-051, QA-SEC-006, QA-PICK-017 · **Treatment:** `REQUIRED PLATFORM CAPABILITY WITH OPTIONAL CONNECTOR`
**Note — significant tension:** the vendor publicly asserts de-identification before upload, yet Phase 8 **directly observed patient-identifiable clinical detail (age indicators, procedure descriptions) inside the authenticated application**. See §7 **C-09**.

#### PUB-036 · Accommodates shifts not present in the hospital system
**Src:** "Mobile Picklist" · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** ENT-031, FEAT-030 · **Treatment:** `REQUIRED FOR PRODUCTION` — imported and manually-created work items must coexist in one pool.

#### PUB-037 · Morning review: list and daily notes reviewed and paired with pre-scheduled pick order
**Src:** "Mobile Picklist" · **Class:** `CORROBORATED`
**Auth:** Picklist Manager's per-date Comments box, Staff panel (numbered, derived from the schedule), and Work panel.
**Maps to:** FEAT-030, ENT-029, ENT-030, STM-012 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-038 · Staff may be added, removed, or re-ordered; room information modified; notes added
**Src:** "Mobile Picklist" · **Class:** `CORROBORATED`
**Auth:** Work panel drag handles; Add/Delete room controls; per-date comments.
**Maps to:** FEAT-030, ENT-030, ENT-031, STM-012 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** the room-creation control is the site of the research's only safety incident (FEAT-048) — capability retained, mechanism replaced.

#### PUB-039 · Staff on the current list are emailed when the list starts
**Src:** "Mobile Picklist" · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-040, ENT-034, STM-013, STM-015 · **Treatment:** `REQUIRED FOR PRODUCTION` · **See GAP-13.**

#### PUB-040 · Staff notified by prior preference across SMS, email, automated voice
**Src:** "Mobile Picklist"; "Notifications" pillar; "Custom Notifications" · **Class:** `CORROBORATED`
**Auth:** four-channel escalation ladders at group-default and per-user level.
**Maps to:** FEAT-040, ENT-035, STM-016 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-041 · Proxy selection so another staff member can choose on your behalf
**Src:** "Mobile Picklist"; "Custom Notifications" ("Perhaps you are on vacation and would like to have another staff member **choose your list**") · **Class:** `CORROBORATED`
**Auth:** Pick Proxy toggle, proxy-user selector, Save Proxy; admin `Proxy Locked` flag.
**Maps to:** TERM-019, FEAT-034, ENT-010, STM-019 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note — resolves a Phase 13 ambiguity:** the public wording "**choose your list**" indicates the proxy **acts (picks), not merely receives notifications**. Phase 13 could not distinguish these and flagged it as blocking (D-04). **See AMD-06 and PO-DEC-03.**

#### PUB-042 · Staff review remaining choices and receive a confirmation email after selecting
**Src:** "Mobile Picklist" · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-032, ENT-032, STM-014 · **Gap:** the remaining-choice review screen and the per-selection confirmation email are **both unobserved**. **See GAP-13.** · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-043 · Automatic advancement to the next staff member by pick order; entirely automated
**Src:** "Mobile Picklist" ("The next staff is contacted according to their pick order. The system is entirely automated.") · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-032, ENT-030, STM-013 · **Treatment:** `REQUIRED FOR PRODUCTION` · **See GAP-13.**

#### PUB-044 · Administrator sees live progress, changes order, or picks on behalf of staff
**Src:** "Mobile Picklist" · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-035, FEAT-032, STM-013 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** "administrator picks for staff" is a distinct intervention capability with real authorization and audit consequences. **See GAP-14.**

#### PUB-045 · Configurable per-turn time limit before intervention is requested
**Src:** "Mobile Picklist" ("The group can set a time limit for how long a staff gets to pick before requesting intervention") · **Class:** `CORROBORATED`
**Auth:** Group Settings `Alert Pick Time` / `Alert Average Pick Time`; per-user `Action Time`.
**Maps to:** TERM-064, FEAT-030, ENT-029, STM-013, STM-014 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** confirms `Action Time`'s purpose, previously **UNRESOLVED** (#14).

#### PUB-046 · Observed operating metrics: ~15 min average response; 20+ picks complete in 4–8 hours
**Src:** "Mobile Picklist" · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-032, QA-PICK-006 · **Treatment:** `REQUIRED FOR PRODUCTION` — adopt as a design/benchmark expectation. **See SBX-031.**

#### PUB-047 · Hours of operation customisable **by group and by individual staff**
**Src:** "Mobile Picklist"; "Custom Notifications" · **Class:** `CORROBORATED`
**Auth:** Group `Pick List Start/End Time` and `Personal Start/End Time`; per-user personal hours.
**Maps to:** TERM-066, FEAT-040, ENT-035 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-048 · On completion the final list is emailed to staff and the list administrator
**Src:** "Picklist" pillar; "Mobile Picklist" · **Class:** `CORROBORATED`
**Auth:** completed-picklist Email modal offering Pick List / Work Assignment / Both; Group Settings `Final Picklist Emails` distribution list.
**Maps to:** FEAT-030, FEAT-040, ENT-034 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-049 · Picks completed to date and claimed time/cost savings
**Src:** homepage statistics footer · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** *(marketing metric — no feature mapping)* · **Treatment:** n/a
**Note:** implies a cross-tenant aggregate usage metric exists. Not a SchedulePoint requirement; recorded for completeness.

### 3.4 Communications and sharing

#### PUB-050 · Telecommunications staff can access the On Call schedule online
**Src:** "Share" · **Class:** `CORROBORATED`
**Auth:** the `Telecom` Access Level exists as a first-class role, almost uniformly with `Admin Emails: Yes`, `Show In Grid: No`, and no picklist participation.
**Maps to:** TERM-014, FEAT-006, ENT-007 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** confirms the purpose of the Telecom role, previously **INFERRED** from flag patterns alone.

#### PUB-051 · Physicians can be phoned or SMS-messaged directly
**Src:** "Share" · **Class:** `CORROBORATED`
**Maps to:** FEAT-041, ENT-005 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-052 · Centralized contact information; email or message staff online
**Src:** "Share" · **Class:** `CORROBORATED`
**Auth:** Contacts directory with Send Email / Send SMS composition dialogs.
**Maps to:** FEAT-041, ENT-004, ENT-005 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-053 · **Group email address included in the standard edition**
**Src:** pricing PDF, standard edition inclusions · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** *(no existing feature)* → **proposed FEAT-056** · **Gap:** **no group email address field or mailbox feature exists anywhere in Group Settings.** The nearest artefact is `Final Picklist Emails`, a distribution list for one specific event. **See GAP-15, AMD-02.** · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-054 · Private document repository for sharing files with staff
**Src:** "Share"; pricing PDF standard edition · **Class:** `CORROBORATED`
**Maps to:** FEAT-050, ENT-038, ENT-038b, STM-020 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-055 · Statistical fairness reports, online and printed
**Src:** "Fair" pillar; "Keep it Fair"; pricing PDF standard edition · **Class:** `CORROBORATED`
**Maps to:** FEAT-023, FEAT-024, ENT-039 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-056 · Scheduler creates printed reports and **emails them to department members for review**
**Src:** "Keep it Fair" · **Class:** `CORROBORATED`
**Auth:** a "Sharing Statistics Report" dialog with staff-recipient multi-select, a filter multi-select, and a message body (found in the coverage audit, never opened).
**Maps to:** FEAT-024, ENT-039, SM-12 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-057 · Identify outlying statistics quickly
**Src:** "Keep it Fair" · **Class:** `CORROBORATED`
**Auth:** Shift Statistics `Show Variance` control; Credits/Target/Actual comparison.
**Maps to:** FEAT-023 · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-058 · iCal subscription; shareable with friends and family
**Src:** "Personal" pillar; "Calendar Integration"; pricing PDF standard edition · **Class:** `CORROBORATED`
**Auth:** `webcal://` Subscribe modal.
**Maps to:** FEAT-042, ENT-037, STM-021 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** the public "share with friends and family" framing makes the **feed's weak credential model materially worse** — the vendor actively encourages distributing a URL that embeds an email address and a long-lived bearer token. Reinforces the SchedulePoint redesign (QA-SEC-005/009).

#### PUB-059 · Beautiful display of the personal work calendar
**Src:** "It's Personal" · **Class:** `CORROBORATED`
**Maps to:** FEAT-011, SCH-01 · **Treatment:** `REQUIRED FOR PRODUCTION`

### 3.5 Platform, access, and commercial model

#### PUB-060 · Supported browsers and devices; no dedicated hardware or installed software
**Src:** "Works Across Modern Devices"; "Technology" pillar · **Class:** `CORROBORATED`
**Claim:** Latest Chrome, Firefox, Opera, Safari, Internet Explorer; phone, tablet, laptop, desktop; Mac or PC; iPhone, Android, Blackberry; Chrome recommended.
**Maps to:** FEAT-054, QA-A11Y-015, QA-A11Y-016 · **Treatment:** `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR`
**Note:** the named browser/device matrix (Internet Explorer, Blackberry) is **`POSSIBLY LEGACY` — reason: the authenticated application carries a `supportIE7` DOM artefact and a 2014-era widget suite, and both named platforms are discontinued.** SchedulePoint must set its own current support matrix.

#### PUB-061 · No iPhone required; notification-only phones usable; login from a nearby computer
**Src:** FAQ "Do I need an iPhone…?" · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** Most features work on Android/Blackberry/Windows phones; a phone without internet can receive notifications and the user can then log in from any computer; some users use WiFi-only handsets.
**Maps to:** FEAT-031, FEAT-032, QA-A11Y-016 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** an explicit design constraint — **notification delivery and pick execution must be decoupled**, so a notification channel need not be the channel used to act.

#### PUB-062 · Two editions plus an IT-integration add-on
**Src:** pricing PDF · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** "Scheduling With Paper Picklist" (standard) and "Scheduling With Mobile Picklist" (optional upgrade), plus a separate one-time "IT SETUP" charge for surgical-booking integration.
**Maps to:** *(no existing feature)* → **proposed FEAT-057 (edition/entitlement model)** · **Gap:** **the consolidated research models no edition, entitlement, or feature-gating concept at all.** **See GAP-16, AMD-03.** · **Treatment:** `SCHEDULEPOINT DECISION REQUIRED`

#### PUB-063 · Standard edition inclusion list
**Src:** pricing PDF; FAQ "What does it cost?" · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** Standard edition includes requests, opportunity board, shift swaps, statistics, direct iCal access, private document library, **group email address**, schedule planner and workbench.
**Maps to:** FEAT-020, FEAT-025, FEAT-026, FEAT-023, FEAT-042, FEAT-050, proposed FEAT-056, FEAT-016 · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** this list is the vendor's own definition of a *minimum viable scheduling product* — a useful external cross-check on SchedulePoint's MVP. See §9.

#### PUB-064 · Commercial terms
**Src:** pricing PDF · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** Per-staff monthly and annual pricing; six-month minimum for new groups and for the mobile picklist; one-time per-staff IT setup fee; staff-and-rules setup included; 8h online scheduler training; +2h picklist-manager training on the upgrade; additional training hourly; **part-time locums free, full-time locums charged at the staff rate**; payment upfront; prices in CAD plus tax; implementation 2–4 weeks.
**Maps to:** proposed FEAT-057; `Payment Due Date` field · **Treatment:** `SCHEDULEPOINT DECISION REQUIRED`
**Note:** "part-time locums are free" is a **billing rule that depends on the Locum role and an FTE threshold** — a commercial concern that reaches into the domain model.

#### PUB-065 · Implementation, onboarding, and support model
**Src:** FAQ cost/competitors; TESTIMONIAL_B/E/F · **Class:** `PUBLIC SOURCE CLAIM`
**Claim:** 2–4 week implementation; vendor performs staff and rules setup; an electronic survey is used to learn the group's needs; go-live within ~3 weeks reported; support via ticket submission.
**Maps to:** *(service model, not product)* · **Treatment:** `SCHEDULEPOINT DECISION REQUIRED` — determines how much rule authoring must be **self-service** in SchedulePoint versus vendor-performed. **See PO-DEC-05.**

#### PUB-066 · Designed by a physician; algorithms in use since 2003/2008, "verified for fairness"
**Src:** footer; FAQ competitors; TESTIMONIAL_D · **Class:** `PUBLIC SOURCE CLAIM`
**Maps to:** FEAT-017 · **Treatment:** n/a — provenance claim. **No algorithm may be copied; SchedulePoint's engine must be independently designed.**

### 3.6 Authentication (application's own public pages)

#### PUB-067 · Email address is the username; password authentication; no SSO or MFA offered
**Src:** `/users/login`, `/users/forgotpassword` · **Class:** `AUTHENTICATED OBSERVATION`
**Observed:** `Email` (type=email) and `Password` fields, a submit control, and a `rememberMe` checkbox labelled "Stay signed in (Personal Device)". No SSO, federation, or MFA control is present anywhere on the page.
**Maps to:** FEAT-008, ENT-004, STM-017 · **Resolves:** unresolved-question **#29** (login form fields) · **Treatment:** `REQUIRED FOR PRODUCTION`
**Note:** SchedulePoint should treat absent MFA/SSO as a **gap to close**, not a baseline to match, for a healthcare workforce product.

#### PUB-068 · Anti-forgery token present on public forms
**Src:** `/users/login`, `/users/forgotpassword` · **Class:** `AUTHENTICATED OBSERVATION`
**Observed:** a hidden `__RequestVerificationToken` field on both forms — the ASP.NET framework convention. **Field name only; no value was read or recorded.**
**Maps to:** QA-AUTH-012, FEAT-008 · **Resolves:** unresolved-question **#76** (anti-forgery mechanism) · **Treatment:** `REQUIRED FOR PRODUCTION`

#### PUB-069 · Password reset is emailed-link based and **doubles as the new-user activation path**
**Src:** `/users/login` (link labelled "RESET PASSWORD (New Users)"), `/users/forgotpassword` · **Class:** `AUTHENTICATED OBSERVATION`
**Observed:** reset page states the email address is the username, that a reset link will be emailed, and directs unresolved problems to a support ticket. The login page routes **new users** to the same reset flow.
**Maps to:** FEAT-008, STM-017, STM-018, QA-AUTH-004 · **Resolves:** unresolved-question **#29** (password-reset flow) · **Treatment:** `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR`
**Note:** conflating activation with password reset is convenient but weakens both — an invitation should be a distinct, single-use, expiring, revocable artefact (STM-017). SchedulePoint should separate them.

#### PUB-070 · Persistent session option, explicitly scoped to personal devices
**Src:** `/users/login` (`rememberMe`, "Stay signed in (Personal Device)") · **Class:** `CORROBORATED`
**Auth:** a `remember` cookie name was observed in Phase 11 (name only, never a value).
**Maps to:** FEAT-008, QA-AUTH-001, QA-AUTH-013 · **Treatment:** `REQUIRED FOR PRODUCTION`

---

## 4. Public-source capability inventory — summary

**70 public claims catalogued (PUB-001..PUB-070).**

| Classification | Count | Notes |
|---|---:|---|
| `CORROBORATED` | 30 | Public claim + authenticated observation agree |
| `PUBLIC SOURCE CLAIM` | 34 | Asserted publicly; **not proven to exist in the current application** |
| `AUTHENTICATED OBSERVATION` | 4 | The application's own public auth pages (PUB-067..070, one also corroborated) |
| `POSSIBLY LEGACY` | 1 | PUB-060 browser/device matrix — reason stated |
| Marketing/provenance only | 2 | PUB-049, PUB-066 |

**Coverage check:** all 8 FAQ answers, all 7 long-form product sections, all 6 capability pillars, the full testimonial block, the mission/statistics footer, both public auth pages, and every pricing-document capability claim were reviewed and assigned PUB IDs.

---

## 5. Missing or underrepresented functionality

Sixteen gaps. Each states what the consolidated research holds today and the exact shortfall.

| ID | Gap | Research today | Shortfall | Class | Treatment |
|---|---|---|---|---|---|
| **GAP-01** | Staff work-percentage as a first-class attribute | Staff Shift FTE holds per-weekday quotas + Max Shifts | No explicit work-percentage field; picklist balancing "by work percentage" (PUB-012) has no visible input | `UNRESOLVED` | `REQUIRED FOR PRODUCTION` |
| **GAP-02** | Template / alternating-week assignment | Pattern Rules express spacing and offsets | No repeating multi-week template authoring surface (PUB-007) | `UNRESOLVED` | `REQUIRED FOR PRODUCTION` |
| **GAP-03** | Staff preference attributes (e.g. "likes 16-hour call") | Staff Rules condition on shifts, groups, offsets, staff balance | No preference/attribute storage on a membership that a rule could read (PUB-010) | `INFERRED` | `REQUIRED FOR PRODUCTION` |
| **GAP-04** | Circulate a partial schedule for review, then resume generation | Progressive Build chains builds | No "circulate/review" workflow, no partial-publication concept (PUB-013) | `UNRESOLVED` | `REQUIRED FOR PRODUCTION` |
| **GAP-05** | Planner + workbench: conflict detection and build-quality verification | ENT-025b/ENT-026b proposed as SchedulePoint additions | **The Planner screen never rendered; Fix Picks never opened.** The product's headline "verify quality / identify conflicts" capability is entirely unobserved (PUB-016) | `UNRESOLVED` | `REQUIRED FOR PRODUCTION` |
| **GAP-06** | Skill sets / qualifications / credentials | Staff Groups = named subsets | **No credential, certification, licence, competency, or expiry concept anywhere** (PUB-018). Confirmed absent by direct term search | `UNRESOLVED` | `REQUIRED FOR PRODUCTION` |
| **GAP-07** | "No Call" and positive ON requests | TERM-048 recorded as having no source evidence | Public source names ON requests and a "No Call" request type explicitly (PUB-021) | `PUBLIC SOURCE CLAIM` | `REQUIRED FOR PRODUCTION` |
| **GAP-08** | Opportunity email fan-out, recipient rules, opt-outs | Notification on posting recorded UNRESOLVED (#33) | Public claim asserts automatic email to **all group members**; recipient rules and opt-outs unknown (PUB-024) | `PUBLIC SOURCE CLAIM` | `REQUIRED FOR PRODUCTION` |
| **GAP-09** | Staff-over-locum preference for extra work | No such rule observed | A distinct eligibility/priority mechanism on opportunity claiming (PUB-025) | `PUBLIC SOURCE CLAIM` | `REQUIRED FOR PRODUCTION` |
| **GAP-10** | Email to affected staff on schedule change | Audit log observed; notification never found | The notification half of PUB-027 is unobserved | `UNRESOLVED` | `REQUIRED FOR PRODUCTION` |
| **GAP-11** | Picklist operating modes (paper / manual / integrated) | One implicit mode | **Three distinct modes exist commercially** (PUB-030, PUB-031, PUB-032); no mode switch observed | `PUBLIC SOURCE CLAIM` | paper = `ADMINISTRATIVE FALLBACK OR OVERRIDE`; others `REQUIRED FOR PRODUCTION` |
| **GAP-12** | Hospital surgical-booking integration | **Absent from the feature inventory entirely** | Named connectors, daily sync scripts, de-identification, failure handling (PUB-032..035) | `EXTERNAL SPECIFICATION REQUIRED` | `REQUIRED PLATFORM CAPABILITY WITH OPTIONAL CONNECTOR` |
| **GAP-13** | Picklist execution surfaces | FEAT-032 marked Low confidence throughout | Start email, remaining-choice review, selection confirmation email, automatic advancement (PUB-039, 042, 043) | `SANDBOX TEST REQUIRED` | `REQUIRED FOR PRODUCTION` |
| **GAP-14** | Administrator intervention: reorder live, pick on behalf of staff | Correction via the schedule cell editor | In-flight picklist intervention is a distinct capability with its own authorization and audit needs (PUB-044) | `SANDBOX TEST REQUIRED` | `REQUIRED FOR PRODUCTION` |
| **GAP-15** | Group email address | Only `Final Picklist Emails` exists | A standard-edition inclusion with no corresponding field (PUB-053) | `UNRESOLVED` | `REQUIRED FOR PRODUCTION` |
| **GAP-16** | Edition / entitlement / feature-gating model | No edition concept modelled | Two editions + an integration add-on drive real feature gating (PUB-062, PUB-064) | `SCHEDULEPOINT DECISION REQUIRED` | `SCHEDULEPOINT DECISION REQUIRED` |

**Also newly observed during targeted corroboration (not public claims — authenticated findings that Phase 13 lacked):**

| ID | Finding | Significance |
|---|---|---|
| **GAP-17** | **`Pick List Access` — a group-level checkbox in Group Settings** | Never documented in any phase. **A strong candidate explanation for C-02**: picklist access may be gated at group level rather than by the per-user `Picklist Admin` flag. `AUTHENTICATED OBSERVATION` |
| **GAP-18** | **`Payment Due Date` — a Group Settings field** | Never documented. Implies per-group subscription/billing state inside the product, supporting the edition model (GAP-16). `AUTHENTICATED OBSERVATION` |
| **GAP-19** | **`Convert to lowercase when importing` — a Group Settings checkbox** | Never documented. A second import-normalisation control alongside `ImportStrip`, corroborating a real file/data import pipeline (GAP-12). `AUTHENTICATED OBSERVATION` |

---

## 6. Capabilities incorrectly scoped in Phase 13

| Capability | Phase 13 disposition | Public evidence | Corrected recommendation |
|---|---|---|---|
| **Automated schedule generation** (FEAT-016) | `MVP` | PUB-001, PUB-002, PUB-017 — the product's central claim | **`REQUIRED FOR PRODUCTION`.** Confirmed correct, and now explicitly non-negotiable. Manual scheduling is a fallback only |
| **Opportunity board** (FEAT-025) | `POST-MVP` | PUB-024, PUB-063 — a **standard-edition inclusion**, praised in two testimonials as a primary reason for adoption | **Reclassify to `REQUIRED FOR PRODUCTION`.** It is part of the vendor's own minimum product. Sequencing may still place it after first release, but it cannot be absent from the finished product |
| **Shift swaps** (FEAT-026) | `REQUIRES DECISION` | PUB-028, PUB-063 — standard-edition inclusion | **`REQUIRED FOR PRODUCTION`.** The acceptance model remains a decision (PO-DEC-02); the capability does not |
| **Reports/statistics** (FEAT-024) | `POST-MVP` | PUB-055, PUB-056, PUB-063 — standard-edition inclusion; fairness reporting is the "Fair" pillar | **`REQUIRED FOR PRODUCTION`** |
| **Calendar subscription** (FEAT-042) | `POST-MVP` | PUB-058, PUB-063 — standard-edition inclusion | **`REQUIRED FOR PRODUCTION`** (with the redesigned token model) |
| **Document library** (FEAT-050) | `POST-MVP` | PUB-054, PUB-063 — standard-edition inclusion | **`REQUIRED FOR PRODUCTION`** |
| **Picklist family** (FEAT-030/031/032/035) | `POST-MVP` | The entire "Mobile Picklist" section; the paid upgrade edition; the product's stated differentiator | **`REQUIRED FOR PRODUCTION`.** Post-MVP sequencing remains sensible given the evidence gaps, but it must not be dropped |
| **Voice / SMS channels** (FEAT-040) | voice `POST-MVP` | PUB-040, PUB-046, PUB-061 — automated voice calling is core to how picking actually works | **`REQUIRED FOR PRODUCTION`** |
| **Clinical case detail** (FEAT-051) | `EXCLUDED` | PUB-035 asserts de-identification before upload | **Remains `EXCLUDED` for the MVP** — but see C-09; the *room/work-item* data pipeline is required, and only patient-level content is excluded |

> **No capability is removed from the production product by this addendum.** Where Phase 13 said "post-MVP", that remains a *sequencing* statement; production completeness is preserved and traceable.

---

## 7. Source contradictions

### Existing contradictions — effect of public evidence

#### C-01 · Three vs. six access levels
**Public evidence:** none. **Change:** none. **Status:** remains resolved by supersession (methodology lesson). **Blocks:** nothing.

#### C-02 · Permission labels vs. actual picklist access — **⚠ still blocking**
**Public evidence:** none directly.
**New authenticated evidence (this task):** **GAP-17 — a group-level `Pick List Access` checkbox exists in Group Settings**, never previously documented. This is a plausible mechanism by which a user with `Picklist Admin: No` retained full picklist access: the gate may be **group-scoped, not user-scoped**.
**Does stronger saved evidence resolve it?** No. This is a *new hypothesis*, not a resolution — the flag's actual effect was not tested and must not be.
**Missing test:** **SBX-002** (role × `Pick List Access` × `Picklist Admin` matrix).
**Proposed SchedulePoint resolution:** role-based capabilities plus **explicitly tested** granular grants; a group-level feature toggle (entitlement, GAP-16) is modelled **separately** from a user-level permission, so the two can never be confused. **Preserves the capability** (granular picklist administration) while removing the ambiguity.
**Approval required:** **yes.** **Blocks:** architecture and implementation of picklist permissions; **does not** block schedule-side architecture.

#### C-03 · One request record vs. separate vacation/request records
**Public evidence:** PUB-021 lists "No Call, days off or request to be assigned certain shifts" **in one breath** as "shift requests", while PUB-022/PUB-023 describe vacation as a **separate module** with its own allocation modes.
**Effect:** **strengthens** the Phase 13 recommendation — the public source itself treats *shift requests* as one family and *vacation* as a distinct module.
**Proposed resolution:** one `Request` entity (ENT-018) with a type discriminator covering ON / OFF / No Call / shift-group requests, and `VacationSelection` (ENT-019) retained as a **separate but linked** entity. **Preserves both capabilities** and matches the vendor's own conceptual split.
**Approval required:** yes (confirmatory). **Blocks:** request domain model only.

#### C-04 · Real-time push vs. polling — **⚠ still blocking**
**Public evidence:** PUB-043 ("The system is entirely automated", next staff contacted automatically) and PUB-044 (administrator "can easily see the **progress** of the list") both imply **live progression**, but neither states a transport.
**Change:** raises the *requirement* for timely progression; does **not** resolve the transport question.
**Missing test:** **SBX-021** (live execution with instrumented transport) and **SBX-023** (reconnection/stale state).
**Proposed resolution:** unchanged — push for turn-critical state, explicit refresh for administrative lists, connections scoped per page.
**Approval required:** **yes.** **Blocks:** picklist architecture.

#### C-05 · Instant-commit "Add" vs. explicit-save forms
**Public evidence:** none. **Change:** none. **Resolution:** unchanged — universal stage-then-save. **Blocks:** design-system definition only.

#### C-06 · Contacts population vs. Users population
**Public evidence:** PUB-050 confirms `Telecom` is a **service role for switchboard access to on-call data**, and PUB-052 describes Contacts as a staff directory.
**Effect:** **materially supports** the leading hypothesis — non-person/service roles (Telecom, View) are plausibly excluded from the staff directory by design, explaining the consistent ~30–35% shortfall in both groups.
**Still unresolved:** the exact filter rule. **Missing test:** **SBX-003.**
**Proposed resolution:** explicit `accountType` (ENT-004) plus an explicit directory-membership rule. **Preserves** the directory while making the population deliberate.
**Approval required:** yes. **Blocks:** nothing.

#### C-07 · Mobile reflow
**Public evidence:** PUB-060/PUB-061 assert broad device support. **Change:** none — Phase 10 measurements stand. **Blocks:** nothing.

### New contradictions raised by public evidence

#### C-08 · **Automated scheduling: central product claim vs. under-weighted research treatment** — *(resolved by this addendum)*
**Conflict:** the public source presents automated generation as the product's defining capability (PUB-001, PUB-002, PUB-017), yet **no build was ever run** in thirteen phases, and the engine's runtime behaviour, conflict detection, and failure states are entirely unobserved (GAP-05).
**Resolution:** **automated scheduling is hereby classified `REQUIRED FOR PRODUCTION`.** Manual scheduling (FEAT-012, FEAT-027) is an **`ADMINISTRATIVE FALLBACK OR OVERRIDE`** and a development-stage tool — **never the production scheduling solution.** Recorded in §9 and in MASTER-CHECKLIST.
**Approval required:** no — this follows directly from the task brief and the public evidence. **Blocks:** **production** (a SchedulePoint release without a working engine would not be a substitute for iSchedule.MD).

#### C-09 · **De-identification claim vs. observed clinical detail** — ⚠
**Conflict:** PUB-035 publicly asserts "All patient identifying data is removed prior to upload", yet Phase 8 **directly observed patient-identifiable clinical content (age indicators, procedure descriptions) inside the authenticated application**.
**Possible reconciliations (none confirmed):** the vendor's definition of "identifying" excludes age/procedure; de-identification applies only to the *integrated import path* while manually-entered content is unconstrained; or the claim is aspirational.
**This is not resolvable from the website** and **must not be tested against production data.**
**Proposed SchedulePoint resolution:** treat de-identification as a **platform obligation enforced at the ingestion boundary**, not a connector promise — with an explicit, tested field allow-list, and no patient-level content in the MVP at all.
**Approval required:** **yes.** **Blocks:** **connector release** (not MVP architecture). **Class:** `SOURCE CONTRADICTION` + `EXTERNAL SPECIFICATION REQUIRED`.

#### C-10 · **Push notifications claimed but absent** — ⚠
**Conflict:** the homepage "Notifications" pillar states the product "uses email, SMS, **push notification** and automated phone calls". The authenticated Notification Settings screen exposes exactly **four** channel columns — Email, SMS, Dial Mobile, Dial Home — and the word "push" appears **nowhere** on that page. Confirmed by direct term search during this task.
**Classification:** `SOURCE CONTRADICTION`. **`POSSIBLY LEGACY` is *not* asserted** — there is no evidence of a removed feature; it may equally be marketing overreach or a roadmap item.
**Proposed resolution:** SchedulePoint should implement push as a **first-class channel** in the notification model (ENT-034/ENT-035) since it is the cheapest, most reliable mobile channel and the source's own value proposition depends on timely mobile contact. Not required for first release, but **required for production** given the product promise.
**Approval required:** yes. **Blocks:** nothing structurally — the channel abstraction already accommodates it.

#### C-11 · Group email address claimed but absent
**Conflict:** the pricing document lists a "group email address" as a standard-edition inclusion (PUB-053); no such field or feature exists in Group Settings.
**Reconciliation:** most plausibly a vendor-provisioned mailbox or alias managed **outside** the application. `UNRESOLVED`.
**Proposed resolution:** model it explicitly (proposed FEAT-056) rather than inheriting an out-of-band arrangement. **Approval required:** yes. **Blocks:** nothing.

#### C-12 · Edition model absent from the product research
**Conflict:** two commercial editions plus an integration add-on gate real functionality (PUB-062, PUB-063), yet the application exposes no edition/entitlement surface and the consolidated research models none.
**New supporting evidence:** the `Payment Due Date` field (GAP-18) shows some commercial state *is* held per group.
**Proposed resolution:** model entitlement explicitly (proposed FEAT-057) and keep it **strictly separate from permissions** — this also protects the C-02 resolution.
**Approval required:** yes. **Blocks:** **architecture** (entitlement checks are cross-cutting and expensive to retrofit).

---

## 8. Proposed Phase 13 amendments

**Reports 12–16 were not modified by this task.** The following amendments are recorded by stable ID for a later, coherent completeness pass.

| ID | Target | Amendment | Driver |
|---|---|---|---|
| **AMD-01** | 13-feature-inventory | **Add FEAT-055 · Surgical-booking integration & import pipeline.** Actors: platform, hospital IT. Covers automated imports, manual imports, daily sync, named connectors, de-identification at ingestion, scheduling/retry/idempotency/reconciliation, failure handling, audit, retention. Disposition `REQUIRED PLATFORM CAPABILITY WITH OPTIONAL CONNECTOR` | GAP-12, PUB-032..035, C-09 |
| **AMD-02** | 13-feature-inventory | **Add FEAT-056 · Group email address / group mailbox.** Disposition `REQUIRED FOR PRODUCTION` | GAP-15, PUB-053, C-11 |
| **AMD-03** | 13-feature-inventory; 14-domain-model | **Add FEAT-057 · Edition, entitlement, and feature gating**, and **ENT-041 Entitlement** (org/group-scoped, separate from ENT-008 PermissionGrant). Disposition `SCHEDULEPOINT DECISION REQUIRED` | GAP-16, PUB-062..064, C-12, GAP-18 |
| **AMD-04** | 12-product-glossary; 14-domain-model; 15-state-machines | **Revise TERM-048 (ON request)** from "no observed source evidence — defer" to `PUBLIC SOURCE CLAIM`, and **add a "No Call" request type** to ENT-018's `type` enumeration and STM-005 | GAP-07, PUB-021 |
| **AMD-05** | 15-state-machines | **Revise STM-009/STM-010** to record that scheduler review of staff-made changes is **configurable, not mandatory** ("can be reviewed"), and add a `review-optional` policy branch | PUB-026 |
| **AMD-06** | 12-product-glossary; 14-domain-model; 15-state-machines | **Revise TERM-019 / ENT-010 / STM-019:** public evidence indicates the proxy **acts** ("choose your list"), so `act-on-behalf` is the *primary* scope, not a speculative second option. Retain notifications-only as a narrower variant | PUB-041 |
| **AMD-07** | 14-domain-model | **Add fields to ENT-006 Membership:** `workPercentage` and a preference/attribute bag readable by rules | GAP-01, GAP-03, PUB-003, PUB-010 |
| **AMD-08** | 14-domain-model | **Add ENT-042 Qualification** (credential/certification/skill with optional expiry) and relate it to ENT-006 and ENT-011 | GAP-06, PUB-018 |
| **AMD-09** | 13-feature-inventory; 15-state-machines | **Extend FEAT-017 and STM-001** with template / alternating-week assignment rules | GAP-02, PUB-007 |
| **AMD-10** | 13-feature-inventory; 15-state-machines | **Extend FEAT-016 / STM-002** with a "circulate partial schedule for review, then resume generation" stage, and surface conflict detection + build-quality verification (ENT-026b) as first-class | GAP-04, GAP-05, PUB-013, PUB-016 |
| **AMD-11** | 13-feature-inventory | **Add picklist operating modes** (paper / mobile-manual / mobile-integrated) to FEAT-030 as an explicit mode attribute | GAP-11, PUB-030..032 |
| **AMD-12** | 13-feature-inventory; 15-state-machines | **Extend FEAT-025 / STM-008** with email fan-out to group members, recipient rules, opt-outs, and **staff-over-locum claim preference** | GAP-08, GAP-09, PUB-024, PUB-025 |
| **AMD-13** | 13-feature-inventory; 14-domain-model | **Add push as a channel** to FEAT-040 and ENT-034/ENT-035b | C-10 |
| **AMD-14** | 13-feature-inventory | **Extend FEAT-032/FEAT-035** with administrator in-flight intervention (reorder live, pick on behalf), and FEAT-030 with list-start email, remaining-choice review, and per-selection confirmation email | GAP-13, GAP-14, PUB-039, 042, 043, 044 |
| **AMD-15** | 14-domain-model | **Add `Pick List Access` (group-level) and `Payment Due Date` to ENT-002 Group**, and `Convert to lowercase when importing` to the import-configuration set | GAP-17, GAP-18, GAP-19 |
| **AMD-16** | 16-research-completion | **Record that unresolved questions #29 and #76 are now resolved** by PUB-067/068/069, and that #14 (`Action Time`) is resolved by PUB-045 | §3.6, PUB-045 |
| **AMD-17** | 13-feature-inventory | **Reclassify to `REQUIRED FOR PRODUCTION`:** FEAT-024, FEAT-025, FEAT-026, FEAT-042, FEAT-050, and the picklist family — all are standard-edition inclusions or the paid differentiator | §6, PUB-063 |

---

## 9. Production treatment: automated vs. manual scheduling

**Recorded explicitly, as required:**

- **Automated schedule generation (FEAT-016, FEAT-017, STM-001) is `REQUIRED FOR PRODUCTION`.** SchedulePoint must not enter production without a working scheduling engine. This is the source product's defining capability (PUB-001, PUB-002, PUB-017), the basis of its pricing (PUB-063), and the reason customers adopted it (multiple testimonials describe replacing 30–40 hours of manual work per schedule cycle).
- **Manual scheduling (FEAT-012 direct cell editing, FEAT-027 administrative reassignment) is an `ADMINISTRATIVE FALLBACK OR OVERRIDE`** — legitimate and required as a correction path, a recovery mechanism, and a development-stage tool, but **explicitly not an acceptable substitute for the production engine.**
- Development may stage the engine behind manual tooling; **production completeness remains traceable** through FEAT-016/017 and STM-001/002.

---

## 10. Product-owner decisions required

| ID | Decision | Driver | Recommendation | Blocks |
|---|---|---|---|---|
| **PO-DEC-00** | **Product name: SchedulePoint or SchedulePilot?** | This brief uses "SchedulePilot"; the repository and all 16 reports use "SchedulePoint" | Confirm one name before any scaffolding; a rename after implementation is costly | Scaffolding |
| **PO-DEC-01** | **C-02** picklist permission model, now informed by group-level `Pick List Access` | GAP-17 | Role capabilities + tested grants; entitlement modelled separately | Architecture (picklist) |
| **PO-DEC-02** | **Swap/offer review model** — public says review is optional | PUB-026 | Counterpart acceptance required; scheduler review **configurable per group** | Marketplace design |
| **PO-DEC-03** | **Proxy scope** — public indicates the proxy *picks* | PUB-041 | Ship `act-on-behalf` with full attribution to the acting party | Picklist design |
| **PO-DEC-04** | **Edition/entitlement model** | GAP-16, C-12 | Model entitlement explicitly, separate from permissions | **Architecture** |
| **PO-DEC-05** | **Rule authoring: self-service vs. vendor-configured** | PUB-014, PUB-065 | Self-service authoring with a vendor-assist onboarding service | Engine UX scope |
| **PO-DEC-06** | **Domain genericisation** (e.g. "Operating Rooms" → demand units) | PUB-019 | Genericize; keep anaesthesia presets | Glossary/UX |
| **PO-DEC-07** | **Push notification channel** | C-10 | Include as a first-class channel | Notification model |
| **PO-DEC-08** | **De-identification ownership** — platform vs. connector | C-09, PUB-035 | Platform-enforced at ingestion, with a tested allow-list | **Connector release** |
| **PO-DEC-09** | **MFA/SSO** — absent in source | PUB-067 | Close the gap; do not inherit the baseline | Auth architecture |
| **PO-DEC-10** | **Locum billing rule** ("part-time locums free") reaching into the domain model | PUB-064 | Keep billing derived from, not embedded in, scheduling data | Entitlement design |

---

## 11. Architecture-blocking findings

1. **C-02** — picklist permission model (now with the `Pick List Access` hypothesis). Blocks picklist authorization design.
2. **C-04** — real-time transport for picklist state. Blocks picklist architecture.
3. **C-12 / PO-DEC-04** — entitlement and feature gating is cross-cutting and expensive to retrofit; it must be decided before the permission and tenancy layers are built.
4. **GAP-12 / AMD-01** — the integration boundary (pull vs. push, ownership, idempotency, reconciliation, de-identification) shapes the ingestion architecture. `EXTERNAL SPECIFICATION REQUIRED`.

---

## 12. Production-blocking findings

1. **Automated scheduling must work** (C-08). A release without a functioning engine does not replace the source product.
2. **GAP-05** — conflict detection and build-quality verification: the engine's output must be reviewable, or schedulers cannot trust it. Entirely unobserved today.
3. **GAP-13 / GAP-14** — picklist execution and administrator intervention: the paid differentiator cannot ship on inference. Requires **LIVE-SIM** sandbox evidence.
4. **C-09** — de-identification at the ingestion boundary must be specified and tested before any connector release.
5. **GAP-06** — qualifications/credentials: assigning unqualified staff is a patient-safety-adjacent failure. Required before production scheduling of a real department.
6. **Notification delivery evidence** (FEAT-040) — voice and SMS are load-bearing for how picking actually works (PUB-046, PUB-061); a production release needs delivery, retry, and failure visibility that the source lacks entirely.

---

## 13. Cross-references

- PUB IDs are defined in §3; SBX IDs in [18-targeted-sandbox-test-plan.md](18-targeted-sandbox-test-plan.md).
- TERM/FEAT/ENT/STM/QA IDs and contradictions C-01..C-07 — reports [12](12-product-glossary.md), [13](13-feature-inventory.md), [14](14-domain-model.md), [15](15-state-machines.md), [11](11-edge-cases-and-qa.md).
- New contradictions **C-08..C-12** are defined in §7 of this report.
- Proposed amendments **AMD-01..AMD-17** are recorded in §8 and **have not been applied** to reports 12–16.
