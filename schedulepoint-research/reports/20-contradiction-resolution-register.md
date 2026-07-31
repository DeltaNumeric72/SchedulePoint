# 20 — Contradiction Resolution Register

**Created 2026-07-31.** Companion to [19-schedulepoint-production-capability-baseline.md](19-schedulepoint-production-capability-baseline.md).

**Product name:** `SchedulePoint` — **PO-DEC-00 APPROVED**.


> ## ✅ PRODUCT-OWNER APPROVAL RECORDED — 2026-07-31
>
> Four decisions arising from this register are now **explicitly approved by the product owner**: **`PO-DEC-02`** (C-02 authorization model), **`PO-DEC-18`** (C-04 real-time transport), **`PO-DEC-04`** (C-12 entitlement architecture, technical only), and **`PO-DEC-08`** (C-09 de-identification ownership).
>
> **What approval changes:** the *SchedulePoint design* for each is settled, and the architecture-definition phase is unblocked.
>
> **What approval does not change:** every statement below about **iSchedule.MD's own behaviour** stands exactly as written. Approving a SchedulePoint design does **not** establish what the source does. C-02's and C-04's source facts remain `UNRESOLVED`; C-09's source contradiction remains **unproven in both directions**. Approval is also **not** implementation or verification — no sandbox test has been run and no gate has passed.
>
> Full decision package: [24-production-completeness-gates.md](24-production-completeness-gates.md) §5–§6.

**Purpose:** give every contradiction C-01..C-12 a concrete, actionable resolution. **No contradiction is left with only "more research needed."** Where production evidence cannot safely settle a question, this register defines the recommended SchedulePoint behaviour *and separately* retains the sandbox test needed to validate the assumption.

**Standing distinction applied throughout:** *what the source does* (uncertain, sometimes unknowable without prohibited actions) is kept strictly separate from *what SchedulePoint will do* (a decision we can make now). A resolved SchedulePoint behaviour does not imply a resolved source fact.

---

## Register format

Each entry carries: conflicting evidence · strongest evidence · source behaviour vs. SchedulePoint behaviour · resolution · **user outcome preserved** · affected features / entities / state machines / permissions / notifications / integrations · QA and sandbox tests · architectural consequences · privacy or safety consequences · **recommended default** · consequence if rejected · approval still required · blocks (architecture / beta / production).

---

## C-01 · Role enumeration: three values vs. six

**Conflicting evidence.** Phase 1 recorded three Access Levels from a single page of the roster. Phase 3, after paginating both groups' full rosters (197 rows) and reading the dropdown options by two independent methods, found **six**.

**Strongest evidence.** Phase 3's exhaustive enumeration. Phase 1's was a sampling error, and self-identified as partial.

**Source behaviour.** Six named tiers exist: Staff, Locum, View, Telecom, Scheduler, Genius. Their *capabilities* were never established for five of the six — only Scheduler was ever exercised.

**SchedulePoint behaviour.** Do **not** copy the six labels. Design permissions around **explicit, individually tested capabilities**, then compose named roles from them. Two of the source labels are vendor-specific ("Genius") or customer-specific ("Telecom") and describe neither a capability nor a hierarchy.

**Resolution.** Treat the six-value enumeration as authoritative *source evidence* and as an input to role design, not as SchedulePoint's permission model. Roles are presets over capabilities; capabilities are the unit of authorization.

**User outcome preserved.** Every distinct working style the six tiers represent — clinician, relief clinician, read-only viewer, notification-only recipient, operational administrator, senior administrator — remains expressible.

**Affected:** FEAT-006 · ENT-006, ENT-007, ENT-008 · STM-017, STM-018 · **Permissions:** the whole model · **Notifications:** the notification-only role (CAP-044) · **Integrations:** none.

**QA / sandbox.** QA-AUTH-006, QA-TEN-003, QA-TEN-012 · **SBX-001** (role × route matrix — the only way to learn what five of the six tiers can actually do).

**Architectural consequences.** Capability-based authorization must be in place before any role preset is defined. Roles must not be hard-coded into authorization checks.

**Privacy / safety.** The View and Telecom tiers exist partly to *limit* data exposure; SchedulePoint must preserve that intent via field-level minimisation (CAP-042), not by copying labels.

**Recommended default.** Capability-based model with composed role presets. **Status: RESOLVED.**

**If rejected.** Copying the six labels imports two names that describe nothing and a hierarchy that does not exist (Telecom and View are sideways from Staff, not below it), and reproduces C-02's ambiguity.

**Approval still required:** no — this is a design decision within the team's remit.
**Blocks:** nothing. Informs architecture.

---

## C-02 · Permission label vs. actual picklist access ⚠

**Conflicting evidence.** The reviewing account held `Picklist Admin: No` yet retained full Picklist Manager, Dashboard, and picklist-administration access throughout thirteen phases. **New evidence from the reconciliation:** a previously-undocumented **group-level `Pick List Access` checkbox** exists in Group Settings (GAP-17).

**Strongest evidence.** The authenticated observation that the flag did not gate the capability it names — reproduced across the entire research effort. The `Pick List Access` checkbox is a **plausible explanation**, not proof; its effect was never tested and must not be tested in production.

**Source behaviour.** `UNRESOLVED.` The gate may be the group setting, the Access Level, some combination, or the flag may be vestigial. **This register does not assert which.**

**SchedulePoint behaviour — layered authorization, four distinct layers:**

1. **Entitlement** — the organization or group licenses the Picklist module (ENT-041). *Does this customer have the module?*
2. **Group availability** — a group-level setting enables the module for that group. *Is this group using it?*
3. **Membership role** — provides baseline access. *What kind of user is this?*
4. **Explicit capability** — controls each individual action. *May this person do this specific thing?*

Plus two invariants: **server authorization enforces every action** (UI visibility merely reflects it), and **no permission flag may exist without a tested capability difference** — a flag whose removal changes no test outcome does not ship.

**Resolution.** Adopt the four-layer model. Keep entitlement (layer 1) architecturally separate from permission (layers 3–4) — conflating them is precisely what makes the source's behaviour hard to reason about.

**User outcome preserved.** Granular picklist administration remains possible; an organization can still say "this group runs picklists" and "this person may start one" independently.

**Affected:** FEAT-006, FEAT-030, FEAT-032, FEAT-057 · ENT-006, ENT-007, ENT-008, ENT-041 · STM-012, STM-013, STM-024 · **Permissions:** the core model · **Notifications:** none directly · **Integrations:** entitlement gates the integrated picklist mode.

**QA / sandbox.** QA-AUTH-007, QA-AUTH-008, QA-TEN-012 · **SBX-002** (the 2×2×role truth table across `Picklist Admin` × `Pick List Access` × role) — **retained regardless of the resolution**, because the SchedulePoint design must be verified even though the source question stays open.

**Architectural consequences.** **Blocking.** Authorization layering and the entitlement/permission separation must be settled before the permission layer is built. Retrofitting a fourth layer later touches every authorization check.

**Privacy / safety.** A permission model whose flags do not gate what they name is a latent authorization defect. Shipping one would be worse than shipping none.

**Recommended default.** The four-layer model above. **Status: RESOLVED as a SchedulePoint design — `PO-DEC-02` APPROVED 2026-07-31.**

**The approved model is:** `organization entitlement → group/module availability → membership role → explicit action capability`, with permissions scoped to organization and group where applicable, every action authorized on the server, database policies providing additional tenant isolation where practical, interface visibility reflecting but never replacing server authorization, no permission flag without a documented and tested capability difference, and **denial as the default when a policy is absent or ambiguous**.

**The source fact remains `UNRESOLVED` and is not asserted.** This approval does **not** establish what iSchedule.MD's `Picklist Admin` flag or its group-level `Pick List Access` setting actually mean — that question stays open and is not answered by choosing SchedulePoint's own model. SBX-002 is retained.

**If rejected.** Any simpler model either loses granularity (a group cannot enable the module without granting every member administrative rights) or reproduces the untested-flag problem.

**Approval still required:** **no — `PO-DEC-02` APPROVED 2026-07-31.**
**Blocks:** architecture is **unblocked**. The architectural work of designing these layers is still to be done, and implementation and verification remain future work.

---

## C-03 · One request record vs. separate vacation/request records

**Conflicting evidence.** Two withdrawal surfaces exist — a per-row DELETE on the requests panel and a Remove on the vacation grid — and it was never established whether they act on one record or two. The shift-group "OFF {X}" creation surface was never located after four phases of search.

**New evidence.** The public source lists "No Call, days off or request to be assigned certain shifts" together as **shift requests** (PUB-021), while describing vacation as a **separate module** with its own allocation modes (PUB-022, PUB-023).

**Strongest evidence.** The public source's own conceptual split, corroborated by the authenticated structure: vacation has a distinct grid, distinct settings, distinct quota accounting, and a distinct commit operation.

**Source behaviour.** `UNRESOLVED` at the record level.

**SchedulePoint behaviour.** **One canonical Request domain** with typed categories and shared audit infrastructure, allowing specialised subtype data and state machines for: shift preference · ON request · OFF request · No Call request · time off · vacation selection · vacation transfer. **Every view operates on the same authoritative state with consistent withdrawal rules.**

**Resolution.** ENT-018 Request is the canonical entity with a `type` discriminator; ENT-019 VacationSelection remains a **linked specialisation** carrying vacation-specific quota and commit semantics — not a parallel universe.

**User outcome preserved.** Staff still request time off, decline call, ask for particular shifts, and select vacation weeks. Schedulers still approve individually or in batch. What changes is that withdrawal means the same thing everywhere.

**Affected:** FEAT-020, FEAT-021, FEAT-022 · ENT-018, ENT-019, ENT-020, ENT-021b, ENT-025 · STM-005, STM-006, STM-007 · **Permissions:** approval capability · **Notifications:** decision notifications · **Integrations:** none.

**QA / sandbox.** QA-REQ-001..014 · **SBX-010** (all types end-to-end, including the never-located creation surfaces), **SBX-011** (one record or two), **SBX-012** (vacation modes).

**Architectural consequences.** The request domain model cannot be finalised without this. Moderate — it shapes one aggregate, not the whole system.

**Privacy / safety.** Absence data is health-adjacent (`SENSITIVE-PII`); one canonical store makes minimisation and retention enforceable in one place.

**Recommended default.** One typed Request domain with a linked vacation specialisation. **Status: RESOLVED as a SchedulePoint design.**

**If rejected.** Two parallel entities reproduce the source's ambiguity, double the withdrawal logic, and make "what did I actually request?" answerable only by knowing which screen you started from.

**Approval still required:** **YES — PO-DEC-03** (confirmatory).
**Blocks:** request domain model; not architecture as a whole.

---

## C-04 · Real-time push vs. polling and manual refresh ⚠

**Conflicting evidence.** A real-time hub named for the picklist connects on **every** page load — including pages with no live feature — yet the picklist administration UI presents a staleness indicator ("last synced N minutes ago") and a manual refresh control. **New evidence:** the public source states the system is "entirely automated" with automatic advancement (PUB-043) and that an administrator can "easily see the **progress** of the list" (PUB-044) — raising the *requirement* for timeliness without naming a transport.

**Strongest evidence.** Both authenticated observations are solid and genuinely in tension. The public claims establish that live progression is expected behaviour, not an optional nicety.

**Source behaviour.** `UNRESOLVED.` Plausible reconciliations (none confirmed): the hub carries only turn events while list metadata is polled; the hub exists but the administration list does not subscribe; or the refresh control is legacy.

**SchedulePoint behaviour — hybrid, deliberately split:**

- **Real-time updates for turn-critical picklist state** (whose turn it is, which work items remain, time remaining).
- **Version numbers / optimistic-concurrency tokens** on every mutable picklist object.
- **Atomic room selection** — the claim is a conditional update, never a read-then-write.
- **Reconnection and resynchronisation** — the server owns turn state and the clock; a dropped client never loses a turn.
- **A visible connection and staleness indicator** — the user always knows whether they are seeing live data.
- **Explicit refresh fallback** — always available, never the primary mechanism for turn-critical state.
- **Page-scoped subscriptions** — a real-time connection opens only where a live feature exists, not globally.
- **Administrative list views may use ordinary query refresh** where immediacy is unnecessary.

**Resolution.** Adopt the hybrid. The split is deliberate and documented: staleness has real operational consequences during a live turn (a missed turn is a real failure) and none on an administrative list screen.

**User outcome preserved.** Staff see it is their turn promptly and never lose one; administrators watch progress live; nobody is left guessing whether the screen is current.

**Affected:** FEAT-032, FEAT-035, FEAT-030 · ENT-029, ENT-030, ENT-031, ENT-032 · STM-013, STM-014 · **Permissions:** administrator intervention · **Notifications:** turn-start notification is a separate channel from live UI state · **Integrations:** none.

**QA / sandbox.** QA-PICK-005, QA-PICK-011, QA-PICK-012, QA-PICK-013, QA-CON-004, QA-PERF-006 · **SBX-021** (instrumented live execution), **SBX-022** (simultaneous selection), **SBX-023** (reconnection and stale state) — **retained as verification of the SchedulePoint design**, not as source archaeology.

**Architectural consequences.** **Blocking.** Push vs. poll determines server topology, connection budget, failure modes, and cost. The source's own pattern (a connection on every page load, including pages that need none) is a concrete anti-pattern to avoid — CAP-067.

**Privacy / safety.** A missed turn caused by stale state is an operational failure with real consequences for shift coverage. Correctness here matters more than elegance.

**Recommended default.** The hybrid above. **Status: RESOLVED as a SchedulePoint architecture requirement — `PO-DEC-18` APPROVED 2026-07-31 — pending sandbox verification.**

**The approved design is:** server-authoritative real-time push for turn-critical picklist state · atomic state transitions with version or concurrency tokens · reconnection with automatic resynchronization · visible connection and staleness state · explicit refresh as a fallback · real-time connections scoped to the pages that require them · ordinary request/refresh for administrative lists where immediacy is unnecessary. **Polling alone must not be relied on for room selection or turn advancement, and real-time connections must not be opened globally on every page.**

**This does not establish how iSchedule.MD uses its own real-time channel.** The source's transport question remains `UNRESOLVED`. SBX-021, SBX-022 and SBX-023 are **retained** to verify concurrency, reconnection, and stale-state recovery in SchedulePoint.

**If rejected.** Full polling makes turn-critical state stale by design; full push over-engineers administrative screens and multiplies idle connections.

**Approval still required:** **no — `PO-DEC-18` APPROVED 2026-07-31.**
**Blocks:** architecture is **unblocked**. **Production remains blocked** until the retained sandbox tests pass — approval is not verification.

---

## C-05 · Instant-commit "Add" vs. explicit-save forms

**Conflicting evidence.** Nearly every form in the source uses explicit Save/Cancel, but one "Add" control **created a live record on a single click** with no draft stage — causing the only safety incident of the research.

**Strongest evidence.** The incident itself: a real record was created and removed, verified by before/after state.

**Source behaviour.** Internally inconsistent, and therefore unpredictable to a user. `AUTHENTICATED OBSERVATION`.

**SchedulePoint behaviour.** A design-system contract: **no control labelled Add, New, or Create may persist data before (a) a completed form, (b) validation, and (c) an explicit Save or confirmation.** Additionally, inspection and destruction never share a click target (the vacation-badge defect, FEAT-047).

**Resolution.** Enforce at the component level — an "add" component that persists on click cannot be built without deliberately bypassing the contract — and test every such control.

**User outcome preserved.** Users still create rooms, users, rules, and requests. They simply cannot do so by accident.

**Affected:** FEAT-030, FEAT-047, FEAT-048, and every creation surface · ENT-031 and all created entities · STM-012 · **Permissions:** none · **Notifications:** none · **Integrations:** none.

**QA / sandbox.** QA-PICK-003, QA-REQ-006 · **SBX-020** (verify no control persists before Save).

**Architectural consequences.** Design-system level, not architecture. Cheap if adopted early; expensive to retrofit across many components.

**Privacy / safety.** Directly prevents the class of accident that occurred during research — in production, on live clinical scheduling data.

**Recommended default.** The contract above. **Status: RESOLVED.**

**If rejected.** Accidental live-data creation becomes possible, and the product inherits the exact defect the research proved is real.

**Approval still required:** no.
**Blocks:** design-system definition; beta.

---

## C-06 · Contacts population vs. Users population

**Conflicting evidence.** The contacts directory shows consistently ~30–35% fewer rows than the user roster — in **both** groups — via an undocumented filter.

**New evidence.** The public source confirms the Telecom role's purpose is switchboard access to on-call data (PUB-050) and describes Contacts as a staff directory (PUB-052), supporting the hypothesis that service and non-person accounts are excluded by design.

**Strongest evidence.** The cross-group consistency of the shortfall plus the public confirmation of a service-only role. Still **not** a proven rule.

**Source behaviour.** `UNRESOLVED` as to the exact filter.

**SchedulePoint behaviour.** Model the concepts explicitly rather than filtering implicitly:

- **person account** · **organization membership** · **staff profile** · **functional/shared account** · **assignable placeholder** · **directory visibility** · **messaging eligibility**

Directory inclusion is an **explicit policy** over these, not an emergent side effect. Default: person accounts with an active membership appear; functional accounts appear only if flagged as a contact point; placeholders never appear.

**Resolution.** Explicit account typing (ENT-004 `accountType`) plus an explicit directory-visibility policy, with field-level PII minimisation by role layered on top.

**User outcome preserved.** Colleagues still find and contact each other; the directory stops silently omitting people for reasons nobody can state.

**Affected:** FEAT-005, FEAT-041 · ENT-004, ENT-005, ENT-006 · STM-018 · **Permissions:** directory visibility, messaging eligibility · **Notifications:** recipient resolution for broadcasts · **Integrations:** none.

**QA / sandbox.** QA-SEC-014, QA-AUTH-011 · **SBX-003** (derive the source's actual rule), **SBX-030a** (recipient resolution).

**Architectural consequences.** Minor — an attribute and a policy, decided early.

**Privacy / safety.** Direct: the source exposes personal mobile, home phone, and personal email broadly with no evident minimisation. Explicit visibility policy is the fix.

**Recommended default.** As above. **Status: RESOLVED as a SchedulePoint design.**

**If rejected.** An emergent filter reproduces a directory nobody can reason about, and blocks any defensible PII-minimisation story.

**Approval still required:** **YES — PO-DEC-20** (default visibility policy).
**Blocks:** nothing.

---

## C-07 · Mobile reflow: "no visible reflow" vs. working breakpoints

**Conflicting evidence.** Phase 1 recorded that a phone-viewport resize "did not visibly reflow" the layout. Phase 10 measured a genuine sidebar→hamburger breakpoint and shrink-to-fit calendar behaviour.

**Strongest evidence.** Phase 10 — it used a proper resize methodology and took measurements. Phase 1's entry was self-labelled inconclusive.

**Source behaviour.** Responsive behaviour exists and largely works; the one real failure is page-level horizontal overflow on the contacts table at phone width.

**SchedulePoint behaviour.** Meet its own responsive and accessibility requirements regardless of what the source does: no page-level horizontal scroll at any supported width; wide tables scroll within their own container with a visible affordance; content and function preserved at 400% zoom.

**Resolution.** Accept Phase 10's measurements as authoritative source evidence; set independent SchedulePoint requirements.

**User outcome preserved.** Mobile use — a core scenario for a product whose value proposition is picking from anywhere — works properly.

**Affected:** FEAT-054 · CAP-066 · **Entities/state machines:** none · **Permissions:** none · **Notifications:** none · **Integrations:** none.

**QA / sandbox.** QA-A11Y-015, QA-A11Y-016 · **SBX-034** (zoom and reflow — never tested against the source).

**Architectural consequences.** None. Front-end requirement.

**Privacy / safety.** None directly; accessibility conformance is a production gate in its own right (CAP-066).

**Recommended default.** As above. **Status: RESOLVED.**

**If rejected.** n/a — no reasonable alternative.

**Approval still required:** no.
**Blocks:** nothing (accessibility separately blocks production).

---

## C-08 · Automated scheduling central to the product but under-weighted in research

**Conflicting evidence.** The public source presents automated generation as the product's defining capability, its pricing basis, and the reason customers adopted it. Yet **no build was ever run** across thirteen phases, and the engine's runtime behaviour, conflict detection, and failure states are entirely unobserved.

**Strongest evidence.** The public source and multiple customer testimonials describing 30–40 hours of manual work per cycle eliminated. The research gap is a *research* limitation (mutating actions were prohibited), not evidence of absence.

**Source behaviour.** A staged, versioned, chainable build pipeline exists and was documented at configuration level. Its execution was never observed.

**SchedulePoint behaviour.** **Automated schedule generation, progressive builds, conflict detection, explainability, and build-quality verification are `REQUIRED FOR PRODUCTION`.** Manual scheduling is an administrator override, a recovery mechanism, a way to create fixed assignments, an input to progressive builds, and a temporary development-stage tool — **never a substitute for the production engine.**

**Resolution.** Recorded in [19](19-schedulepoint-production-capability-baseline.md) §1.3 and specified in full in [21-automated-scheduling-production-requirements.md](21-automated-scheduling-production-requirements.md).

**User outcome preserved.** The outcome that made the source product valuable — a fair, rule-compliant, multi-month schedule produced in seconds rather than tens of hours — is the outcome SchedulePoint must deliver.

**Affected:** FEAT-016, FEAT-017, FEAT-059, FEAT-012, FEAT-027 · ENT-021..ENT-026b, ENT-048 · STM-001, STM-002 · **Permissions:** build capability · **Notifications:** build completion/failure · **Integrations:** none directly.

**QA / sandbox.** QA-SCH-001..007, QA-SCH-005 · **SBX-015** (execution, failure, regeneration), **SBX-016** (conflict detection), **SBX-017** (progressive builds), **SBX-031** (performance and quality).

**Architectural consequences.** The engine is a major subsystem with its own lifecycle, queueing, and explainability model. It cannot be bolted on later without redesigning the schedule domain.

**Privacy / safety.** An engine that assigns unqualified staff, or whose output cannot be reviewed, is a patient-safety-adjacent risk — hence CAP-058 and CAP-059 are both production blockers.

**Recommended default.** As above. **Status: RESOLVED.**

**If rejected.** A release relying on manual scheduling would not replace the source product; it would be a scheduling *spreadsheet with extra steps*, which is precisely what customers left behind.

**Approval still required:** no — this follows from the task mandate and the public evidence.
**Blocks:** **production.**

---

## C-09 · De-identification claim vs. observed clinical detail ⚠

**Conflicting evidence.** The public source asserts "All patient identifying data is removed prior to upload" (PUB-035). Phase 8 directly observed **clinical detail** — age indicators and procedure descriptions — inside the authenticated application.

**Strongest evidence.** Both are solid observations. **They may not actually conflict.**

**Critical distinction — do not collapse these:**

| Category | Example | Identifying? |
|---|---|---|
| Patient-identifying information | name, medical-record number, date of birth, health-card number | **Yes** |
| Non-identifying operational case metadata | procedure type, expected duration, room | No, in isolation |
| Scheduling information | shift code, staff assignment, date | No |
| Free-text notes | arbitrary operator-entered text | **Potentially** — accidental identifiers |

**Which category the observed content fell into was never established**, and the research deliberately never transcribed it. An age indicator may be a precise date of birth (identifying) or an age band (generally not). **This register does not assume the source is in breach, and does not assume it is compliant.**

**Source behaviour.** `SOURCE CONTRADICTION` — **unproven in both directions.** Not resolvable from the website, and **must not be tested against production data.**

**SchedulePoint behaviour.** The privacy obligation is discharged by the platform, not by trusting a connector:

- De-identification **before or at ingestion**, enforced at the boundary
- An **allow-listed import schema** — positive allow-list, never a deny-list
- **Rejection or quarantine** of unexpected identifying fields
- **No patient names · no medical-record numbers · no dates of birth · no health-card or insurance identifiers · no unrestricted clinical free text**
- **Minimum-necessary** operational data only
- Encrypted transport and storage · retention controls · access control · audit logging
- Validation against **representative sanitized fixtures**
- **Connector certification before release**

**Resolution.** The source question stays open; the SchedulePoint behaviour is fully specified and testable.

**User outcome preserved.** Clinicians still see what work they have and where — the operational outcome. What does not enter the product is patient-level content.

**Affected:** FEAT-055, FEAT-062, FEAT-051, FEAT-033 · ENT-045, ENT-031 · STM-023 · **Permissions:** platform-only ingestion · **Notifications:** quarantine alerts to administrators · **Integrations:** **every connector.**

**QA / sandbox.** QA-SEC-006, QA-PICK-017 · **SBX-029** (payloads deliberately containing fabricated patient-shaped fields in expected *and* unexpected positions), **SBX-028** (import validation).

**Architectural consequences.** The ingestion boundary is an architectural component, not connector-local logic. Each connector must be unable to bypass it by construction.

**Privacy / safety.** **The highest-consequence item in this register.** A scheduling product holding patient data inherits clinical-system regulatory obligations without clinical-system controls.

**Recommended default.** Platform-enforced boundary as specified. **Status: SchedulePoint privacy behaviour RESOLVED — `PO-DEC-08` APPROVED 2026-07-31. The source contradiction remains UNPROVEN in both directions.**

**The approved design is:** SchedulePoint **owns and enforces** the ingestion privacy boundary; connector behaviour alone is never trusted to remove identifying information; every connector passes through a **platform-controlled positive allowlist**; unexpected fields are rejected or quarantined; patient names, medical-record numbers, dates of birth, health-card or insurance identifiers, and unrestricted clinical free text **must not persist**; **logs, error payloads, queues, audit events, backups, and observability tooling follow the same restriction**; only minimum-necessary, non-identifying operational scheduling information may pass; every connector requires representative sanitized fixtures and privacy validation before certification; customer-specific privacy-office approval remains required where applicable; and **no hospital connector may ship until the de-identification gate passes**.

**The saved evidence does not prove whether iSchedule.MD did or did not contain patient-identifying information**, and this approval does not assert either. The four-way distinction above is preserved precisely so that the question stays open rather than being resolved by assumption.

**If rejected.** Delegating de-identification to connectors means the platform's privacy posture is only as good as its least careful integration partner.

**Approval still required:** **no for the ownership model — `PO-DEC-08` APPROVED 2026-07-31.** Per-customer definition of identifying fields and privacy-office sign-off remain required at connector certification.
**Blocks:** **connector release** (not architecture). The `G-CONN` gate has **not** passed.

---

## C-10 · Push notifications publicly claimed but absent

**Conflicting evidence.** The public source states the product "uses email, SMS, **push notification** and automated phone calls". The authenticated notification settings screen exposes exactly **four** channels — Email, SMS, Dial Mobile, Dial Home — with **zero** occurrences of "push" anywhere on the page.

**Strongest evidence.** The authenticated observation is direct and was verified by term search. The public claim is unambiguous.

**Source behaviour.** `SOURCE CONTRADICTION`. **`POSSIBLY LEGACY` is not asserted** — there is no evidence of a removed feature. It may equally be marketing overreach, a roadmap item, or a capability delivered by another route (e.g. an SMS-to-push gateway).

**SchedulePoint behaviour.** Implement push as a **first-class channel** using a modern, permission-based mechanism: device or browser registration · **explicit user consent** · channel preferences · retries · expiry · invalid-token cleanup · deduplication · audit history · **fallback channels** when push is unavailable.

**Resolution.** Push is `REQUIRED FOR PRODUCTION`. The product's core value proposition depends on reaching a clinician promptly on a mobile device; push is the cheapest and most reliable such channel, and the public source has already promised it.

**User outcome preserved.** Staff are notified promptly on the device they carry — the outcome the public claim describes — whether or not the source ever delivered it.

**Affected:** FEAT-040, FEAT-061 · ENT-034, ENT-035, ENT-035b, ENT-047 · STM-015, STM-016, STM-025 · **Permissions:** self-managed consent · **Notifications:** the channel set itself · **Integrations:** push provider (platform-level, not a hospital connector).

**QA / sandbox.** QA-NOT-001..012 · **SBX-030b** (push viability and graceful degradation), **SBX-030a** (ladder integration).

**Architectural consequences.** Minor — the channel abstraction already accommodates it. Adding push later is cheap **provided** the notification model is channel-agnostic from the start, which it is (ENT-035b).

**Privacy / safety.** Device tokens are `PII`; consent must be explicit and revocable. Push must never carry clinical content in its payload.

**Recommended default.** Implement as specified. **Status: RESOLVED for SchedulePoint production scope; the source fact remains unproven.**

**If rejected.** SchedulePoint would ship a narrower notification story than the product it replaces publicly advertises.

**Approval still required:** **YES — PO-DEC-07** (confirmatory).
**Blocks:** nothing structurally; production scope.

---

## C-11 · Group email address claimed but absent

**Conflicting evidence.** The pricing document lists a "group email address" as a **standard-edition inclusion** (PUB-053). No such field or feature exists anywhere in Group Settings; the nearest artefact is `Final Picklist Emails`, a distribution list for one specific event.

**Strongest evidence.** Both are direct. The commercial document is explicit about it being included.

**Source behaviour.** `UNRESOLVED` — most plausibly a vendor-provisioned mailbox or alias managed **outside** the application.

**SchedulePoint behaviour.** Provide a **group-scoped communication identity** — a managed group-broadcast address — with defined: membership and eligibility · permitted senders · recipient filtering · opt-outs where legally and operationally permitted · archiving and audit metadata · delivery-failure handling · abuse prevention · confidentiality controls.

**Resolution.** Model it explicitly (ENT-046, FEAT-056) rather than inheriting an out-of-band arrangement nobody can administer or audit.

**User outcome preserved.** A group has a durable communication identity that does not depend on one person's mailbox and survives staff turnover.

**Affected:** FEAT-041, FEAT-056 · ENT-046, ENT-004, ENT-034 · STM-015 · **Permissions:** permitted-sender policy · **Notifications:** broadcast delivery · **Integrations:** email provider (platform-level).

**QA / sandbox.** QA-SEC-013 · **SBX-030a** (recipient resolution, opt-outs, abuse controls).

**Architectural consequences.** Modest. Inbound handling (if replies are supported) is a larger commitment than outbound-only — see the approval note.

**Privacy / safety.** Recipient lists are `PII`; recipients must resolve **only** from the group roster, never free-text, to prevent the address becoming a phishing vector from a trusted domain.

**Recommended default.** Outbound-first: a managed group broadcast identity with archiving, deferring inbound reply handling until a customer needs it. **Status: RESOLVED for SchedulePoint production scope.**

**If rejected.** The capability remains provisioned out of band, unauditable, and invisible to the administrators responsible for it.

**Approval still required:** **YES — PO-DEC-21** (address ownership: vendor-hosted domain vs. customer domain; inbound vs. outbound-only).
**Blocks:** nothing.

---

## C-12 · Edition and entitlement model absent from the research

**Conflicting evidence.** Two commercial editions plus an integration add-on gate real functionality (PUB-062, PUB-063), yet the application exposes no edition or entitlement surface and the consolidated research modelled none. **Supporting evidence:** a `Payment Due Date` field exists on Group Settings (GAP-18), showing some commercial state *is* held per group.

**Strongest evidence.** The pricing document is explicit and structural — it defines what each edition includes.

**Source behaviour.** Entitlement is likely enforced administratively or by configuration rather than by a modelled entitlement system. `UNRESOLVED`.

**SchedulePoint behaviour.** **Separate product functionality from commercial packaging.** The architecture must support: module entitlements · organization-level feature activation · dependency validation · audit history · administrative visibility · **safe disabling** · **no accidental data loss when a feature is disabled**.

**Critically: all required functionality must exist in the completed product even if individual organizations license or enable different modules.** Entitlement controls *activation*, never *existence*.

**Initial proposed entitlement structure** (technical grouping only — pricing and packaging are a product-owner decision):

| Module | Contains |
|---|---|
| **Core Scheduling** | tenancy, identity, shift catalogue, rules, build engine, publication, manual override, audit |
| **Requests & Vacation** | requests, vacation modes, approvals, commit |
| **Marketplace** | opportunity board, offers, swaps, transfers |
| **Communications** | contacts directory, bulk messaging, group identity, all notification channels |
| **Reporting & Documents** | fairness statistics, report generation and sharing, document repository, calendar feeds |
| **Picklist** | preparation, execution, modes (paper, manual-entry), proxy, monitoring |
| **Hospital Integration** | connector framework, de-identification boundary, integrated picklist mode — **depends on Picklist** |

**Resolution.** Model entitlement explicitly (ENT-041, STM-024), strictly separate from permissions, with dependency validation.

**User outcome preserved.** Customers can buy what they need; nothing they have bought silently disappears, and nothing they have not bought is missing from the product itself.

**Affected:** FEAT-057, and every gated feature · ENT-041, ENT-001, ENT-002 · STM-024 · **Permissions:** distinct from entitlement by design · **Notifications:** entitlement changes notify org administrators · **Integrations:** the Hospital Integration module gates connectors.

**QA / sandbox.** QA-TEN-005, QA-AUTH-007 · **SBX-002** (entitlement × permission interaction).

**Architectural consequences.** **Blocking.** Entitlement checks are cross-cutting; retrofitting them means touching every gated surface. It must be decided before the permission and tenancy layers are built.

**Privacy / safety.** Disabling a module must never delete data — a customer downgrading must not lose their schedule history.

**Recommended default.** The structure above, as a **technical** grouping. **Status: technical entitlement architecture RESOLVED — `PO-DEC-04` APPROVED 2026-07-31. Commercial packaging remains PENDING.**

**The approved design is:** entitlements are **first-class organization-level records**, separate from user permissions · modules declare dependencies · dependency validation prevents invalid feature combinations · entitlement changes are audited · **disabling a module must not delete or corrupt its data**, and existing data remains available per retention and administrative policy · product capability must not be scattered across ad hoc interface conditionals · **the completed product must contain all required capabilities even when a customer has not licensed or enabled every module**.

**Pricing and commercial packaging remain a separate, pending product-owner decision.**

**If rejected.** Feature gating ends up scattered through conditionals, and the entitlement/permission confusion at the heart of C-02 is reproduced.

**Approval still required:** **no for the technical architecture — `PO-DEC-04` APPROVED 2026-07-31.** Commercial packaging remains pending and does not block technical work.
**Blocks:** architecture is **unblocked**.

---

## Summary

| ID | Status | Approval required | Blocks |
|---|---|---|---|
| C-01 | **RESOLVED** | no | — |
| **C-02** | **RESOLVED as SchedulePoint design**; **source fact remains UNRESOLVED** | **`PO-DEC-02` APPROVED** | Architecture **unblocked**; design work outstanding |
| C-03 | **RESOLVED as SchedulePoint design** | YES — PO-DEC-03 | Request domain |
| **C-04** | **RESOLVED as architecture requirement**; **source transport remains UNRESOLVED** | **`PO-DEC-18` APPROVED** | Architecture **unblocked**; **Production still blocked** pending SBX-021/022/023 |
| C-05 | **RESOLVED** | no | Design system, Beta |
| C-06 | **RESOLVED as SchedulePoint design** | YES — PO-DEC-20 | — |
| C-07 | **RESOLVED** | no | — |
| C-08 | **RESOLVED** | no | **Production** |
| **C-09** | **Source contradiction remains UNPROVEN in both directions**; SchedulePoint privacy behaviour **RESOLVED** | **`PO-DEC-08` APPROVED** | **Connector release still blocked** — `G-CONN` not passed |
| C-10 | **RESOLVED for production scope** | YES — PO-DEC-07 | — |
| C-11 | **RESOLVED for production scope** | YES — PO-DEC-21 | — |
| **C-12** | **Technical architecture RESOLVED**; commercial packaging **pending** | **`PO-DEC-04` APPROVED** *(technical only)* | Architecture **unblocked** |

**All twelve contradictions have a concrete recommended resolution.** None is left as "more research needed." Nine retain a sandbox test to validate assumptions — those tests verify the **SchedulePoint design**, and in four cases (C-02, C-04, C-06, C-09) they would additionally illuminate the source behaviour, which remains explicitly unasserted.

**Four decisions approved 2026-07-31:** `PO-DEC-02`, `PO-DEC-18`, `PO-DEC-04` (technical), `PO-DEC-08`. The remaining eight decisions arising from this register (`PO-DEC-03`, `07`, `19`, `20`, `21`, plus the commercial half of `PO-DEC-04`) **remain pending** with their documented recommended working defaults. **No decision has been silently marked approved.**

**Approval settles design, not evidence.** No sandbox test has been executed, no production gate has passed, and no connector gate has passed.

**No new contradictions were created by this register.**
