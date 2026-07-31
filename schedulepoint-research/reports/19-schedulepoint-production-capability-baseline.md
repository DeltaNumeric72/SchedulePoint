# 19 — SchedulePoint Production Capability Baseline

**Created 2026-07-30.** **This report is the authoritative definition of SchedulePoint's complete production functionality.** Where any earlier report conflicts on scope, this one governs.

**Product name:** `SchedulePoint` — **PO-DEC-00 APPROVED**.

**Evidence boundary:** derived solely from the saved research and the public-source reconciliation. No browser was used; iSchedule.MD was not visited. The clean-room boundary is preserved — no proprietary source code, private API, algorithm, asset, copy, or database structure is reproduced.

---

## 1. The governing principle

> **SchedulePoint must ultimately provide all useful functionality available in iSchedule.MD.** It may replace unsafe, inaccessible, inconsistent, outdated, privacy-invasive, or defective source behaviour with a safer design — but it must **preserve the underlying capability and user outcome**.

**A capability may not disappear because it is difficult, expensive, integration-dependent, unobserved in execution, marked post-MVP in an earlier report, described only by a public source, or dependent on an external specification.**

Development sequencing may defer *when* a capability is implemented. Production completeness continues to require it.

### 1.1 Vocabulary correction

Earlier reports used `MVP` / `POST-MVP` / `DEFERRED` / `EXCLUDED`. Those described **development sequencing** and were read as though they described **production scope**. They do not.

**The following are not valid production dispositions in this corpus and have been corrected wherever they appeared:** `excluded` · `abandoned` · `optional because difficult` · `indefinitely deferred` · `post-MVP with no production gate`.

### 1.2 Milestone definitions

| Milestone | What it may omit |
|---|---|
| **Internal foundation** | Most product features; establishes tenancy, identity, and platform |
| **Internal functional alpha** | May **temporarily** use manual scheduling while the solver is under development |
| **Controlled beta** | A restricted feature set **only if** the missing functionality is not required by participating test users **and** the limitations are explicitly disclosed |
| **Production release** | Nothing required by §7's gates. Must satisfy [24-production-completeness-gates.md](24-production-completeness-gates.md) |

### 1.3 The scheduling rule

**Automated scheduling is mandatory before production.** Manual scheduling remains available as an administrator override, a recovery mechanism, a way to create fixed assignments, an input to progressive builds, and a temporary development-stage tool — **and is never an acceptable substitute for the production scheduling engine.** See [21-automated-scheduling-production-requirements.md](21-automated-scheduling-production-requirements.md).

---

## 2. Classification and disposition keys

**Evidence classification** (one per capability, describing the *source* evidence):

`AUTHENTICATED OBSERVATION` · `PUBLIC SOURCE CLAIM` · `CORROBORATED` · `INFERRED` · `UNRESOLVED` · `POSSIBLY LEGACY` · `SOURCE CONTRADICTION` · `SCHEDULEPOINT DECISION` · `SANDBOX TEST REQUIRED` · `EXTERNAL SPECIFICATION REQUIRED` · `SUPERSEDED SOURCE BEHAVIOUR`

Public claims are **never** promoted to authenticated observations. An unresolved source fact is **never** converted into an asserted source behaviour. A SchedulePoint decision may define complete behaviour where the source is ambiguous.

**Production disposition** (exactly one per capability):

| Code | Meaning |
|---|---|
| `REQUIRED FOR PRODUCTION` | Must be present and working at production release |
| `REQUIRED PLATFORM CAPABILITY AND NAMED CONNECTOR` | Platform required at production; each named connector additionally certified |
| `REQUIRED PLATFORM CAPABILITY WITH CUSTOMER-SPECIFIC CONNECTOR` | Platform required; the connector is built per customer |
| `ADMINISTRATIVE FALLBACK OR OVERRIDE` | Required to exist; explicitly not the primary mechanism |
| `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` | Source behaviour replaced; **user outcome preserved** |
| `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` | Cannot ship until an external spec is obtained and tested |

**Field key:** **Outcome** = preserved source user outcome · **Ev** = source evidence · **Class** · **PUB** · **FEAT** · **Actors** · **Perm** · **Ent** · **STM** · **Rules** · **UI** · **Notif** · **Rpt** = reports · **Integ** · **Audit** · **Priv** = privacy classification · **Sec** · **A11y** · **Conc** = concurrency · **QA** · **SBX** · **Dep** = implementation dependency · **Milestone** · **Disposition** · **Blocks** (Arch/Beta/Prod) · **Approval** = remaining approval or evidence requirement.

---

## 3. Capability inventory

**58 capabilities.** Every FEAT ID and every PUB ID maps here; see [22-functional-traceability-matrix.md](22-functional-traceability-matrix.md).

### 3.1 Tenancy, identity, and authorization

#### CAP-001 · Organization tenancy root
**Outcome:** a customer's data is isolated and administrable as one unit. **Ev:** absence of any parent above Group · **Class:** `SCHEDULEPOINT DECISION` · **PUB:** — · **FEAT:** FEAT-002
**Actors:** platform operator, org admin · **Perm:** platform/org administration · **Ent:** ENT-001 · **STM:** —
**Rules:** every Group belongs to exactly one Organization; no data crosses the boundary. **UI:** org administration · **Notif:** — · **Rpt:** — · **Integ:** —
**Audit:** all org changes · **Priv:** `INTERNAL` · **Sec:** outermost isolation boundary · **A11y:** standard · **Conc:** —
**QA:** QA-TEN-001, QA-TEN-005, QA-TEN-006 · **SBX:** SBX-004 · **Dep:** none · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Arch · **Approval:** PO-DEC-06 (one org per user for MVP)

#### CAP-002 · Group scheduling scope and switching
**Outcome:** a user works within, and moves between, the groups they belong to. **Ev:** GRP-01, cross-group comparison · **Class:** `AUTHENTICATED OBSERVATION` · **PUB:** — · **FEAT:** FEAT-001
**Actors:** all · **Perm:** any active membership · **Ent:** ENT-002, ENT-006 · **STM:** —
**Rules:** independent roster, settings, rules, vacation period, and picklists per group. **UI:** group switcher · **Audit:** group context changes · **Priv:** `INTERNAL` · **Conc:** —
**QA:** QA-TEN-002..012 · **SBX:** SBX-001, SBX-004 · **Dep:** CAP-001 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Arch · **Approval:** none

#### CAP-003 · Server- and database-enforced tenant isolation
**Outcome:** no user ever sees another tenant's data. **Ev:** groupId carried in three client-controllable places · **Class:** `SCHEDULEPOINT DECISION` · **FEAT:** FEAT-003
**Actors:** platform · **Perm:** n/a · **Ent:** ENT-001, ENT-002, ENT-006 · **Rules:** deny-by-default; a route without an explicit policy fails the build; tenant context resolves server-side from the session, never from a client parameter alone.
**Audit:** all denials · **Priv:** `INTERNAL` · **Sec:** critical · **Conc:** —
**QA:** QA-TEN-005/006/012, QA-SEC-008 · **SBX:** SBX-004 · **Dep:** CAP-001 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Arch, Prod · **Approval:** none

#### CAP-004 · Site (physical location) modelling
**Outcome:** work is attributable to where it happens. **Ev:** Group and Site coincide in the observed tenant but nothing enforces it · **Class:** `INFERRED` · **PUB:** PUB-019 · **FEAT:** FEAT-004
**Actors:** scheduler · **Ent:** ENT-003 · **Rules:** a Site may be referenced by work items and assignments; qualification requirements may be site-scoped.
**QA:** — (`NOT APPLICABLE` — no source behaviour to test; covered by CAP-058 eligibility tests) · **SBX:** SBX-019 · **Dep:** CAP-002 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** **PO-DEC-01** (first-class entity vs. attribute)

#### CAP-005 · User accounts and account types
**Outcome:** people, shared mailboxes, and unfilled placeholders are all schedulable but distinguishable. **Ev:** ADM-05; 02-role §6 · **Class:** `AUTHENTICATED OBSERVATION` · **FEAT:** FEAT-005
**Actors:** administrator · **Perm:** administrator · **Ent:** ENT-004, ENT-005 · **STM:** STM-017, STM-018
**Rules:** explicit `accountType` (person \| functional \| placeholder); **hard deletion is prohibited** where history exists. **UI:** roster administration · **Notif:** invitation, suspension · **Audit:** all lifecycle transitions
**Priv:** `PII` · **Sec:** credential fields `SECRET` · **A11y:** SP-HR-3..6 · **Conc:** deactivation vs. in-flight action
**QA:** QA-AUTH-005, QA-AUTH-011, QA-SEC-014 · **SBX:** SBX-005 · **Dep:** CAP-002 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** none

#### CAP-006 · Membership-scoped roles and capabilities
**Outcome:** a person's authority is correct in each group independently. **Ev:** same individual holding different Access Levels per group · **Class:** `AUTHENTICATED OBSERVATION` · **FEAT:** FEAT-006
**Actors:** administrator · **Ent:** ENT-006, ENT-007, ENT-008 · **Rules:** role lives on Membership; **no permission flag may exist without a tested capability difference**; server authorization enforces every action; UI visibility reflects server authorization.
**Audit:** every role and grant change · **Priv:** `INTERNAL` · **Sec:** critical · **Conc:** —
**QA:** QA-AUTH-006/007/008, QA-TEN-003/012 · **SBX:** SBX-001, SBX-002 · **Dep:** CAP-005, CAP-057 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Arch** · **Approval:** **PO-DEC-02 (C-02)**

#### CAP-007 · Self-service profile, credentials, and preferences
**Outcome:** users maintain their own contact details, password, and defaults. **Ev:** PL-03 · **Class:** `AUTHENTICATED OBSERVATION` · **PUB:** PUB-070 · **FEAT:** FEAT-007
**Actors:** any user · **Perm:** self only · **Ent:** ENT-004, ENT-005, ENT-009
**Rules:** account email is identity and not self-editable; contact visibility is role-governed. **Audit:** credential and contact changes · **Priv:** `SENSITIVE-PII`
**QA:** QA-AUTH-004, QA-SEC-011, QA-SEC-014 · **SBX:** SBX-005 · **Dep:** CAP-005 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** none

#### CAP-008 · Authentication and session management
**Outcome:** users sign in securely and stay signed in when they choose. **Ev:** public login/reset pages · **Class:** `AUTHENTICATED OBSERVATION` *(the application's own public pages)* · **PUB:** PUB-067, PUB-068, PUB-069, PUB-070 · **FEAT:** FEAT-008
**Actors:** all · **Ent:** ENT-004 · **STM:** STM-017
**Rules:** email as username; anti-forgery on every state-changing request; persistent-session option scoped to personal devices; **bounded idle and absolute session lifetimes**.
**UI:** login, reset · **Notif:** reset email · **Audit:** sign-in, failure, lockout · **Priv:** `PII` · **Sec:** `SECRET` credentials · **A11y:** SP-HR-3..6
**QA:** QA-AUTH-001..004, QA-AUTH-012, QA-AUTH-013 · **SBX:** SBX-005, SBX-006 · **Dep:** CAP-001 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** **PO-DEC-09** (MFA/SSO — the source offers neither)

#### CAP-009 · Invitation and activation, separated from password reset
**Outcome:** new users are onboarded safely. **Ev:** the source routes new users through the reset flow · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **PUB:** PUB-069 · **FEAT:** FEAT-005, FEAT-008
**Actors:** administrator, invitee · **Ent:** ENT-004, ENT-006 · **STM:** STM-017
**Rules:** an invitation is a **distinct, single-use, expiring, revocable** artefact — not a password reset. **Notif:** invitation and reminders · **Audit:** issue, accept, expire, revoke
**QA:** QA-AUTH-004 · **SBX:** SBX-005 · **Dep:** CAP-008 · **Milestone:** foundation
**Disposition:** `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` · **Blocks:** Beta · **Approval:** none
**Outcome preserved:** new users still reach an active account by email; the mechanism is safer.

#### CAP-010 · Administrative impersonation
**Outcome:** support can reproduce and fix a user's problem. **Ev:** SYS-05, never submitted; **no audit trail evident** · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **FEAT:** FEAT-009
**Actors:** administrator · **Perm:** explicit capability, separately granted · **Ent:** ENT-004, ENT-040
**Rules:** **mandatory audit**, persistent visible banner, time-limited, **barred from credential-changing screens**, and every action attributed to the real actor via `onBehalfOf`.
**Audit:** session start/end and every action · **Priv:** `PII` · **Sec:** critical
**QA:** QA-AUTH-010 · **SBX:** SBX-005 · **Dep:** CAP-006 · **Milestone:** beta
**Disposition:** `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` · **Blocks:** Beta · **Approval:** **PO-DEC-11**

#### CAP-057 · Entitlement and feature gating
**Outcome:** organizations activate the modules they license, without functionality disappearing from the product. **Ev:** two editions + IT add-on · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-062, PUB-063, PUB-064 · **FEAT:** FEAT-057
**Actors:** platform operator, org admin · **Ent:** ENT-041 · **STM:** STM-024
**Rules:** **an entitlement is not a permission**; dependencies validated; **disabling never destroys data**; administratively visible.
**Audit:** every grant/suspend/revoke · **Priv:** `INTERNAL` · **Conc:** concurrent grants converge
**QA:** QA-TEN-005, QA-AUTH-007 · **SBX:** SBX-002 · **Dep:** CAP-001 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Arch** · **Approval:** **PO-DEC-04** (commercial packaging pending; architecture requirement resolved)

### 3.2 Scheduling structure

#### CAP-011 · Shift type catalogue
**Outcome:** every kind of work is defined once and used consistently. **Ev:** ADM-07 · **Class:** `AUTHENTICATED OBSERVATION` · **FEAT:** FEAT-010 · **Ent:** ENT-011
**Rules:** four orthogonal flags (on-call, manual-only, daily-pick, stipend); overnight handling explicit; retired types are never hard-deleted while assignments reference them.
**QA:** QA-SCH-004, QA-SCH-006, QA-SCH-013 · **SBX:** SBX-015 · **Dep:** CAP-002 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** none

#### CAP-012 · Shift groups and staff groups
**Outcome:** work and people can be bundled for scoring, requests, and eligibility. **Ev:** ADM-06, ADM-08 · **Class:** `AUTHENTICATED OBSERVATION` · **FEAT:** FEAT-013, FEAT-014 · **Ent:** ENT-012, ENT-013
**Rules:** `allowRequest` is a genuine server-side filter; shift groups carry scoring mode and weight. **QA:** QA-REQ-003, QA-SCH-006 · **SBX:** SBX-010 · **Dep:** CAP-011 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** none

#### CAP-013 · Weekday-variable FTE, maximum assignments, work percentage
**Outcome:** part-time and variable-commitment staff are scheduled and scored fairly. **Ev:** ADM-03; public rule examples · **Class:** `CORROBORATED` · **PUB:** PUB-003, PUB-004, PUB-005, PUB-012 · **FEAT:** FEAT-013 · **Ent:** ENT-006, ENT-011
**Rules:** per-shift-type, per-weekday quotas; `Max Shifts`; **explicit stored `workPercentage`** (not derived) used as the fairness denominator and picklist-balancing input.
**QA:** QA-SCH-006 · **SBX:** SBX-015, SBX-031 · **Dep:** CAP-011 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Prod · **Approval:** none — GAP-01 closed by SchedulePoint decision

#### CAP-058 · Qualifications, credentials, expiry, and eligibility
**Outcome:** only appropriately qualified staff are scheduled. **Ev:** "skill sets" claimed; **no representation found anywhere** · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-018 · **FEAT:** FEAT-058
**Actors:** administrator, scheduler, engine · **Ent:** ENT-042, ENT-043, ENT-011 · **STM:** STM-022
**Rules:** **eligibility evaluated against the assignment date, not today**; enforced on **every** assignment path — engine, manual edit, opportunity claim, swap, picklist pick; overrides require a reason and are audited.
**UI:** qualification administration, eligibility warnings · **Notif:** expiry warnings · **Audit:** grants, expiries, overrides · **Priv:** `SENSITIVE-PII` · **Conc:** renewal vs. expiry sweep
**QA:** QA-SCH-006 · **SBX:** SBX-019 · **Dep:** CAP-005, CAP-011 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** **PO-DEC-12** (ownership and verification model)

#### CAP-014 · Schedule periods and versioned publication
**Outcome:** a schedule is published for a bounded period and its history is never lost. **Ev:** builds versioned, published output not; **no rollback control exists** · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **FEAT:** FEAT-015, FEAT-018, FEAT-019 · **Ent:** ENT-015, ENT-016 · **STM:** STM-003, STM-004
**Rules:** publication is atomic and re-checked at commit; prior versions are **superseded, never deleted**; revert publishes forward; affected staff only are re-notified.
**Audit:** publication, supersession, lock, revert · **Conc:** period-scoped serialisation
**QA:** QA-SCH-001/002/009/012/015, QA-CON-010 · **SBX:** SBX-018 · **Dep:** CAP-015 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** none
**Outcome preserved:** schedules still go live; SchedulePoint adds the rollback the source lacks.

#### CAP-015 · Automated schedule generation
**Outcome:** months of complex schedule are produced in seconds instead of tens of hours by hand. **Ev:** the product's central claim; **no build was ever run** · **Class:** `CORROBORATED` *(capability)* / `SANDBOX TEST REQUIRED` *(behaviour)* · **PUB:** PUB-001, PUB-002, PUB-015, PUB-017 · **FEAT:** FEAT-016
**Actors:** scheduler · **Ent:** ENT-024, ENT-025b, ENT-023b · **STM:** STM-001
**Rules:** full specification in [21-automated-scheduling-production-requirements.md](21-automated-scheduling-production-requirements.md). **Never returns only success/failure.**
**Audit:** every stage transition · **Conc:** one generating build per period
**QA:** QA-SCH-001/002/007, QA-CON-002 · **SBX:** SBX-015, SBX-031 · **Dep:** CAP-011..013, CAP-016, CAP-058 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** none — **C-08 resolved**

#### CAP-016 · Rule engine: patterns, staff rules, position restrictions, templates
**Outcome:** complex fairness and eligibility policy is expressed declaratively. **Ev:** ADM-09/10/11 + public rule examples · **Class:** `CORROBORATED` · **PUB:** PUB-006, PUB-007, PUB-008, PUB-009, PUB-010, PUB-011, PUB-012, PUB-014 · **FEAT:** FEAT-017 · **Ent:** ENT-021, ENT-022, ENT-023, ENT-023b, ENT-048
**Rules:** hard constraints vs. weighted preferences; day offsets vs. optimal spacing; five staff-rule actions; negation; staffing-balance conditions; **alternating-week templates (new)**; pick-position exclusions.
**QA:** QA-SCH-005, QA-SCH-006 · **SBX:** SBX-015, SBX-016 · **Dep:** CAP-011, CAP-012 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** **PO-DEC-05** (self-service vs. vendor-authored rules)

#### CAP-017 · Progressive builds around fixed assignments
**Outcome:** part of a schedule can be hand-made and the engine builds around it. **Ev:** Progressive Build chip list; public FAQ · **Class:** `CORROBORATED` · **PUB:** PUB-013 · **FEAT:** FEAT-016 · **Ent:** ENT-024 · **STM:** STM-001, STM-002
**Rules:** locked manual and prior-solver assignments are **preserved exactly**; staged generation; explicit unlocking with a reasoned override; build-version comparison.
**QA:** QA-SCH-002 · **SBX:** SBX-017 · **Dep:** CAP-015, CAP-019 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** none

#### CAP-018 · Partial-schedule circulation
**Outcome:** a draft can be circulated for hand assignment before generation resumes. **Ev:** public FAQ only · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-013 · **FEAT:** FEAT-016 · **Ent:** ENT-016 · **STM:** STM-002
**Rules:** **circulating never makes a schedule authoritative** — it is explicitly distinct from publication.
**QA:** QA-SCH-001 · **SBX:** SBX-017 · **Dep:** CAP-017 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** none

#### CAP-059 · Conflict detection and build-quality verification
**Outcome:** a scheduler can see what is wrong with a generated schedule and why, before publishing. **Ev:** publicly claimed; **Planner never rendered, Fix Picks never opened** · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-016, PUB-057 · **FEAT:** FEAT-059 · **Ent:** ENT-026b, ENT-025b · **STM:** STM-002
**Rules:** every hard breach, unmet demand, eligibility failure, and fairness outlier is surfaced with severity, explanation, and remediation. **Sign-off is blocked while unresolved hard violations remain.**
**QA:** QA-SCH-002, QA-SCH-005 · **SBX:** SBX-016 · **Dep:** CAP-015, CAP-016, CAP-058 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** **PO-DEC-13** (conflict-severity taxonomy)

#### CAP-019 · Manual scheduling, override, and fixed assignments
**Outcome:** a scheduler can always correct the schedule and pin assignments. **Ev:** cell editor with Shifts/Credits split and provenance log · **Class:** `AUTHENTICATED OBSERVATION` · **FEAT:** FEAT-012, FEAT-027 · **Ent:** ENT-014, ENT-017 · **STM:** STM-004
**Rules:** validates **the same eligibility and conflict rules** as the engine; requires an explicit override reason when it breaches a soft rule; creates lockable assignments that feed progressive builds; fully audited.
**Audit:** every edit with actor, mechanism, before/after · **Conc:** optimistic concurrency per assignment
**QA:** QA-SCH-008/011/015, QA-CON-001 · **SBX:** SBX-017, SBX-018 · **Dep:** CAP-014 · **Milestone:** foundation
**Disposition:** `ADMINISTRATIVE FALLBACK OR OVERRIDE` **(and required to exist)** · **Blocks:** Beta · **Approval:** none
**Explicit:** **never a substitute for the production scheduling engine (CAP-015).**

#### CAP-020 · Schedule viewing, three views, and daily assignment sheet
**Outcome:** everyone can see who is working when, and what today looks like. **Ev:** SCH-02/03/04, DA-01 · **Class:** `AUTHENTICATED OBSERVATION` · **PUB:** PUB-059 · **FEAT:** FEAT-011, FEAT-033 · **Ent:** ENT-014 · **A11y:** **SP-HR-3..6 — the source fails all four here**
**Rules:** date/staff/shift views; per-day summary metrics; daily assignment sheet scoped to a picklist; **no patient-level content**.
**QA:** QA-SCH-010/013/014, QA-A11Y-006/012/015 · **SBX:** SBX-033, SBX-034 · **Dep:** CAP-014 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** (accessibility) · **Approval:** none

#### CAP-021 · Requests: ON, OFF, No Call, shift preference
**Outcome:** staff influence their own schedule and schedulers decide. **Ev:** history observed; **creation surface for shift-group requests never located** · **Class:** `CORROBORATED` *(OFF)* / `PUBLIC SOURCE CLAIM` *(ON, No Call)* · **PUB:** PUB-020, PUB-021 · **FEAT:** FEAT-020 · **Ent:** ENT-018, ENT-025 · **STM:** STM-005, STM-006
**Rules:** **one canonical Request domain with typed categories** and shared audit; server-side deadline enforcement; withdrawal (requester) and denial (approver) are distinct; every view operates on the same authoritative state with consistent withdrawal rules.
**QA:** QA-REQ-001..006, QA-REQ-013 · **SBX:** SBX-010, SBX-011 · **Dep:** CAP-005 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** **PO-DEC-03 (C-03)**

#### CAP-022 · Vacation: quota/grant mode and open mode
**Outcome:** departments allocate vacation the way they actually work. **Ev:** VAC-01/02 + FAQ · **Class:** `CORROBORATED` · **PUB:** PUB-022, PUB-023 · **FEAT:** FEAT-021 · **Ent:** ENT-019, ENT-020, ENT-021b · **STM:** STM-007
**Rules:** both modes supported; **over-quota is advisory, not blocking** (a deliberate source behaviour preserved); individual and batch approval; balance decrement atomic with approval.
**QA:** QA-REQ-002, QA-REQ-007..014 · **SBX:** SBX-012, SBX-013 · **Dep:** CAP-021 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** **PO-DEC-14** (default mode)

#### CAP-023 · Vacation commit to schedule
**Outcome:** approved vacation appears on the schedule as time off. **Ev:** irreversible type-to-confirm transfer · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **FEAT:** FEAT-022 · **Ent:** ENT-019, ENT-016 · **STM:** STM-007
**Rules:** **idempotent** (keyed by selection + target version) and **reversible via schedule versioning** — replacing the source's explicitly irreversible operation. The type-to-confirm friction pattern is **retained** for high-blast-radius actions.
**QA:** QA-REQ-010, QA-CON-003, QA-CON-010 · **SBX:** SBX-012 · **Dep:** CAP-014, CAP-022 · **Milestone:** alpha
**Disposition:** `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` · **Blocks:** Beta · **Approval:** none
**Outcome preserved:** batch commit still works; it is now safe to re-run and to undo.

### 3.3 Marketplace

#### CAP-024 · Opportunity board with email fan-out
**Outcome:** staff give up shifts fairly and colleagues get equal access to extra work. **Ev:** posting/removal observed; **claim side never observed** · **Class:** `CORROBORATED` *(post)* / `PUBLIC SOURCE CLAIM` *(fan-out)* · **PUB:** PUB-024 · **FEAT:** FEAT-025 · **Ent:** ENT-026 · **STM:** STM-008
**Rules:** posting notifies group members by email per explicit recipient rules; opt-outs honoured; **atomic conditional claim** — exactly one winner; eligibility re-validated at claim time.
**Notif:** fan-out on post; poster notified on claim · **Conc:** simultaneous claims
**QA:** QA-OPP-001..008 · **SBX:** SBX-013b, SBX-014b · **Dep:** CAP-020, CAP-040 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** **PO-DEC-15** (recipient-filtering default)

#### CAP-025 · Staff preference over locums for extra work
**Outcome:** permanent staff get first access to extra work before locums. **Ev:** publicly claimed; **never observed** · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-025 · **FEAT:** FEAT-025 · **Ent:** ENT-026, ENT-006 · **STM:** STM-008
**Rules:** a configurable **priority window** during which only non-locum members may claim; after it, all eligible members may.
**QA:** QA-OPP-002, QA-OPP-003 · **SBX:** SBX-013b · **Dep:** CAP-024 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** **PO-DEC-16** (window length default)

#### CAP-026 · Shift offers, swaps, and transfers with optional review
**Outcome:** staff arrange their own cover, with scheduler oversight where the group wants it. **Ev:** form observed, never submitted · **Class:** `PUBLIC SOURCE CLAIM` *(review is configurable)* · **PUB:** PUB-026, PUB-028 · **FEAT:** FEAT-026, FEAT-027 · **Ent:** ENT-027, ENT-028 · **STM:** STM-009, STM-010, STM-011
**Rules:** counterpart acceptance **always** required; scheduler review is a **per-group policy**; execution is **atomic — both legs or neither**; affected staff emailed.
**QA:** QA-OPP-009/010/011 · **SBX:** SBX-014c · **Dep:** CAP-020 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** **PO-DEC-17** (default review policy)

#### CAP-027 · Schedule-change audit and affected-staff notification
**Outcome:** every change is attributable and the people affected find out. **Ev:** per-cell provenance log observed; **notification half unobserved** · **Class:** `CORROBORATED` *(log)* / `PUBLIC SOURCE CLAIM` *(email)* · **PUB:** PUB-027 · **FEAT:** FEAT-045 · **Ent:** ENT-040
**Rules:** append-only, queryable audit across **every** entity; targeted re-notification of affected staff only, never a broadcast.
**QA:** QA-SCH-015, QA-AUTH-009, QA-CON-011 · **SBX:** SBX-018, SBX-030a · **Dep:** CAP-019 · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** none

### 3.4 Picklist

#### CAP-030 · Picklist preparation
**Outcome:** a day's draft is assembled and validated before it runs. **Ev:** PLM-01 · **Class:** `AUTHENTICATED OBSERVATION` · **PUB:** PUB-037, PUB-038 · **FEAT:** FEAT-030 · **Ent:** ENT-029, ENT-030, ENT-031 · **STM:** STM-012
**Rules:** participants derived from the published schedule; work items addable, editable, reorderable; **no control persists before an explicit Save (C-05)**.
**QA:** QA-PICK-001..003, QA-PICK-015 · **SBX:** SBX-020 · **Dep:** CAP-014, CAP-060 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Prod · **Approval:** none

#### CAP-060 · Picklist operating modes: paper, manual-entry, integrated
**Outcome:** groups run a picklist the way they are able to — on paper, by hand, or fully integrated. **Ev:** commercially distinct; **no mode switch observed** · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-030, PUB-031, PUB-032 · **FEAT:** FEAT-060 · **Ent:** ENT-029 · **STM:** STM-012
**Rules:** mode is group configuration; imported and manual work items coexist; switching mode never destroys an in-flight list.
**QA:** QA-PICK-001 · **SBX:** SBX-020 · **Dep:** CAP-030 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` *(paper mode: `ADMINISTRATIVE FALLBACK OR OVERRIDE`)* · **Blocks:** Prod · **Approval:** none

#### CAP-031 · Picklist execution
**Outcome:** staff choose their own work, in turn, from any device. **Ev:** **entire execution flow unobserved across thirteen phases** · **Class:** `SANDBOX TEST REQUIRED` · **PUB:** PUB-029, PUB-039, PUB-042, PUB-043, PUB-046, PUB-048 · **FEAT:** FEAT-032, FEAT-031 · **Ent:** ENT-029, ENT-030, ENT-032 · **STM:** STM-013, STM-014
**Rules:** list-start email; server-owned turn state and clock; remaining-choice review; **atomic** selection; per-selection confirmation email; automatic advancement; completion email to staff and administrator.
**A11y:** **the turn allowance must be achievable via assistive technology** · **Conc:** severe — see CAP-032
**QA:** QA-PICK-005..016, QA-A11Y-014 · **SBX:** SBX-021, SBX-024, SBX-027 · **Dep:** CAP-030, CAP-040 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** **PO-DEC-18 (C-04 transport)**

#### CAP-032 · Picklist concurrency and real-time state
**Outcome:** two people never get the same room, and nobody loses a turn to a dropped connection. **Ev:** real-time hub confirmed; **message flow never observed** · **Class:** `SOURCE CONTRADICTION` *(C-04)* · **FEAT:** FEAT-032, FEAT-035 · **STM:** STM-013, STM-014
**Rules:** real-time for turn-critical state; version/optimistic-concurrency tokens; **atomic room selection**; reconnection and resynchronisation; visible connection/staleness indicator; explicit refresh fallback; page-scoped subscriptions; administrative lists may use ordinary query refresh.
**QA:** QA-PICK-005/011/012/013, QA-CON-004 · **SBX:** SBX-022, SBX-023 · **Dep:** CAP-031 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Arch, Prod** · **Approval:** **PO-DEC-18 (C-04)**

#### CAP-033 · Administrator picklist intervention and monitoring
**Outcome:** a scheduler can watch a live draft and unblock it. **Ev:** dashboard empty state only; **active state never opened** · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-044, PUB-045 · **FEAT:** FEAT-035, FEAT-032 · **STM:** STM-013
**Rules:** live progress view; reorder remaining participants; **pick on behalf of a staff member, always attributed to the administrator**; configurable per-turn limit before intervention.
**Audit:** every intervention · **QA:** QA-PICK-008, QA-PICK-013 · **SBX:** SBX-025 · **Dep:** CAP-031 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Prod · **Approval:** none

#### CAP-034 · Proxy delegation
**Outcome:** a staff member on holiday can have a colleague pick for them. **Ev:** structure observed; **semantics never distinguished** · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-041 · **FEAT:** FEAT-034 · **Ent:** ENT-010 · **STM:** STM-019
**Rules:** **`act-on-behalf` is the primary scope**; `notifications-only` is a narrower variant; every proxy action records **both** the acting party and the grantor; admin-lockable.
**QA:** QA-AUTH-008 · **SBX:** SBX-026 · **Dep:** CAP-031 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** **PO-DEC-19** (default scope)

### 3.5 Communications

#### CAP-040 · Notification delivery, escalation, retry, and deduplication
**Outcome:** the right person is reliably reached in time to act. **Ev:** ladders observed; **no delivery log exists anywhere in the product** · **Class:** `CORROBORATED` *(config)* / `SANDBOX TEST REQUIRED` *(delivery)* · **PUB:** PUB-040, PUB-047 · **FEAT:** FEAT-040 · **Ent:** ENT-034, ENT-035, ENT-035b · **STM:** STM-015, STM-016
**Rules:** two-window ladders (business/personal hours) at group-default and per-user level; dispatch **only after the triggering transaction commits**; bounded backoff retry; dead-lettering; explicit `no-destination` outcome; **deduplication**; resolution cancels pending steps.
**Audit:** every attempt and outcome · **Priv:** `PII` — **message bodies never carry clinical content**
**QA:** QA-NOT-001..012, QA-CON-009 · **SBX:** SBX-030a · **Dep:** CAP-005 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** none

#### CAP-041 · Notification channels: email, SMS, voice, push
**Outcome:** staff are reached however they have chosen to be reached. **Ev:** four channels observed; **push publicly claimed but absent** · **Class:** `SOURCE CONTRADICTION` *(push)* / `CORROBORATED` *(others)* · **PUB:** PUB-040, PUB-051, PUB-061 · **FEAT:** FEAT-040, FEAT-061 · **Ent:** ENT-047 · **STM:** STM-025
**Rules:** email, SMS, voice-mobile, voice-home, **and push**; push requires explicit consent, cleans up invalid tokens, and **falls back** when unavailable. **Notification delivery and pick execution are decoupled** — a notification channel need not be the channel used to act (PUB-061).
**QA:** QA-NOT-005, QA-NOT-011 · **SBX:** SBX-030a, SBX-030b · **Dep:** CAP-040 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Prod · **Approval:** **PO-DEC-07 (C-10)**

#### CAP-042 · Contacts directory with minimised PII
**Outcome:** colleagues can find and reach each other. **Ev:** directory observed; **~30–35% smaller than the roster in both groups** · **Class:** `AUTHENTICATED OBSERVATION` · **PUB:** PUB-052 · **FEAT:** FEAT-041 · **Ent:** ENT-004, ENT-005
**Rules:** directory inclusion by **explicit policy**, not an emergent filter; **field-level PII minimisation by role**; the API never returns fields the UI hides.
**QA:** QA-SEC-014 · **SBX:** SBX-003 · **Dep:** CAP-005 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** **PO-DEC-20 (C-06)**

#### CAP-043 · Bulk messaging to staff
**Outcome:** a scheduler can reach the whole group or a subset. **Ev:** compose dialogs observed, never submitted · **Class:** `AUTHENTICATED OBSERVATION` · **PUB:** PUB-052 · **FEAT:** FEAT-041
**Rules:** recipients resolve **only** from the roster (never free-text); rate-limited; audited with recipient count and actor; sender identity unambiguous.
**QA:** QA-SEC-013 · **SBX:** SBX-030a · **Dep:** CAP-042 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** none

#### CAP-056 · Group communication identity
**Outcome:** a group has its own address rather than depending on an individual's mailbox. **Ev:** a standard-edition inclusion with **no corresponding field** · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-053 · **FEAT:** FEAT-056 · **Ent:** ENT-046
**Rules:** defined membership and eligibility; permitted-sender policy; recipient filtering; opt-outs where permitted; archiving with audit metadata; delivery-failure handling; abuse prevention; confidentiality controls.
**QA:** QA-SEC-013 · **SBX:** SBX-030a · **Dep:** CAP-040, CAP-043 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** **PO-DEC-21** (address ownership model)

#### CAP-044 · On-call access for telecom/switchboard
**Outcome:** the hospital switchboard always knows who is on call. **Ev:** Telecom role confirmed by public source · **Class:** `CORROBORATED` · **PUB:** PUB-050 · **FEAT:** FEAT-006, FEAT-011 · **Ent:** ENT-007
**Rules:** a notification-recipient role with on-call visibility, **no schedule presence, and no picklist participation**.
**QA:** QA-TEN-012, QA-AUTH-006 · **SBX:** SBX-001 · **Dep:** CAP-006, CAP-020 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** none

### 3.6 Reporting, documents, calendar

#### CAP-045 · Fairness statistics and variance
**Outcome:** the group can prove work is divided fairly. **Ev:** ADM-04 · **Class:** `CORROBORATED` · **PUB:** PUB-055, PUB-057 · **FEAT:** FEAT-023 · **Ent:** ENT-017
**Rules:** Credits vs. Target vs. Actual; configurable credit weight; variance view; **credit remains independently movable from the assignment**.
**QA:** QA-RPT-002 · **SBX:** SBX-031a · **Dep:** CAP-019 · **Milestone:** alpha
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Prod · **Approval:** none

#### CAP-046 · Reports: generation, print, export, sharing
**Outcome:** schedules and statistics can be produced, printed, and circulated. **Ev:** six report types found passively; **four dialogs never opened** · **Class:** `AUTHENTICATED OBSERVATION` *(existence)* / `SANDBOX TEST REQUIRED` *(behaviour)* · **PUB:** PUB-055, PUB-056 · **FEAT:** FEAT-024 · **Ent:** ENT-039
**Rules:** configure-then-generate (not instant download); recipient-targeted sharing; **tenant-scoped output**; generation audited.
**QA:** QA-RPT-001..008 · **SBX:** SBX-031a · **Dep:** CAP-020, CAP-045 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Prod · **Approval:** none

#### CAP-047 · Calendar feed subscription
**Outcome:** staff see their work in their own calendar and can share it. **Ev:** feed URL carries email **and** a long-lived bearer token in query parameters · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **PUB:** PUB-058 · **FEAT:** FEAT-042 · **Ent:** ENT-037 · **STM:** STM-021
**Rules:** high-entropy, **hash-stored**, revocable, rotatable, read-only, single-membership tokens; **no PII in the URL**.
**QA:** QA-SEC-005, QA-SEC-009, QA-TEN-009 · **SBX:** SBX-031c · **Dep:** CAP-020 · **Milestone:** beta
**Disposition:** `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` · **Blocks:** Beta · **Approval:** none
**Outcome preserved:** subscription and family sharing still work; the credential model is sound.

#### CAP-048 · Private document repository
**Outcome:** the group shares policies and reference files. **Ev:** DOC-01; **no search, no uploader, no versioning** · **Class:** `AUTHENTICATED OBSERVATION` · **PUB:** PUB-054 · **FEAT:** FEAT-050 · **Ent:** ENT-038, ENT-038b · **STM:** STM-020
**Rules:** category tree **plus search** (which the source lacks); uploader and version recorded; signed, short-lived, tenant-scoped URLs invalidated on deletion; role-based category visibility.
**QA:** QA-RPT-009..012, QA-SEC-010 · **SBX:** SBX-031b · **Dep:** CAP-002 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** **PO-DEC-22** (retention policy)

#### CAP-049 · Calendar events on the schedule
**Outcome:** non-shift events (meetings, education) appear alongside work. **Ev:** hidden dialog found passively; row never seen populated · **Class:** `AUTHENTICATED OBSERVATION` · **FEAT:** FEAT-046 · **Ent:** ENT-014
**QA:** — (`NOT APPLICABLE` — no QA case was written for this surface; covered by CAP-020 schedule tests) · **SBX:** SBX-031a · **Dep:** CAP-020 · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** — · **Approval:** none

### 3.7 Integrations and privacy

#### CAP-055 · Hospital surgical-booking integration framework
**Outcome:** room and case-slate data arrives automatically so nobody types it in. **Ev:** publicly claimed; **no import surface ever located** · **Class:** `PUBLIC SOURCE CLAIM` / `EXTERNAL SPECIFICATION REQUIRED` · **PUB:** PUB-032, PUB-033, PUB-034, PUB-036 · **FEAT:** FEAT-055 · **Ent:** ENT-044, ENT-045 · **STM:** STM-023
**Rules:** canonical import schema; **idempotent**; atomic; reconciled against manual items; normalisation controls; failures visible and replayable.
**Integ:** named connectors — ORSOS, Cerner/Surginet, Meditech (CAP-061..063) · **Audit:** every batch · **Priv:** governed by CAP-062
**QA:** QA-CON-003, QA-CON-009, QA-CON-010 · **SBX:** SBX-028 · **Dep:** CAP-030, CAP-062 · **Milestone:** beta
**Disposition:** `REQUIRED PLATFORM CAPABILITY AND NAMED CONNECTOR` · **Blocks:** **Arch** (boundary), connector release · **Approval:** **PO-DEC-08**

#### CAP-061 · ORSOS connector
**Outcome:** groups using this system get automated imports. **Ev:** named publicly · **Class:** `EXTERNAL SPECIFICATION REQUIRED` · **PUB:** PUB-033 · **FEAT:** FEAT-055 · **Ent:** ENT-044
**QA:** QA-CON-003 · **SBX:** SBX-028, SBX-029 · **Dep:** CAP-055 · **Milestone:** post-beta
**Disposition:** `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` · **Blocks:** connector release · **Approval:** vendor/hospital specification

#### CAP-062 · De-identification and ingestion privacy boundary
**Outcome:** the platform never holds patient-identifying information. **Ev:** public de-identification claim vs. observed clinical detail · **Class:** `SOURCE CONTRADICTION` · **PUB:** PUB-035 · **FEAT:** FEAT-062, FEAT-051 · **Ent:** ENT-045 · **STM:** STM-023
**Rules:** **positive allow-list** schema; rejection or quarantine of unexpected identifying fields; **no patient names, no medical-record numbers, no dates of birth, no health-card or insurance identifiers, no unrestricted clinical free text**; minimum-necessary operational data; encrypted transport and storage; retention controls; access control; audit logging; validated against representative sanitized fixtures.
**Priv:** `EXCLUDED` — exists to keep a data class out · **Sec:** critical
**QA:** QA-SEC-006, QA-PICK-017 · **SBX:** SBX-029 · **Dep:** CAP-055 · **Milestone:** beta
**Disposition:** `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` · **Blocks:** **connector release** · **Approval:** **PO-DEC-08 (C-09)**
**Note:** observed clinical detail is **not** assumed to prove patient identification — see C-09 in [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md).

#### CAP-063 · Cerner/Surginet connector
**Outcome:** groups using this system get automated imports. **Ev:** named publicly (and in a customer testimonial) · **Class:** `EXTERNAL SPECIFICATION REQUIRED` · **PUB:** PUB-033 · **FEAT:** FEAT-055 · **Ent:** ENT-044
**QA:** QA-CON-003 · **SBX:** SBX-028, SBX-029 · **Dep:** CAP-055 · **Milestone:** post-beta
**Disposition:** `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` · **Blocks:** connector release · **Approval:** vendor/hospital specification

#### CAP-064 · Meditech connector
**Outcome:** groups using this system get automated imports. **Ev:** named in the public pricing document · **Class:** `EXTERNAL SPECIFICATION REQUIRED` · **PUB:** PUB-033 · **FEAT:** FEAT-055 · **Ent:** ENT-044
**QA:** QA-CON-003 · **SBX:** SBX-028, SBX-029 · **Dep:** CAP-055 · **Milestone:** post-beta
**Disposition:** `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` · **Blocks:** connector release · **Approval:** vendor/hospital specification

#### CAP-065 · Customer-specific connectors
**Outcome:** a customer on an unnamed system can still integrate. **Ev:** "If you can think it, we can build it" · **Class:** `PUBLIC SOURCE CLAIM` · **PUB:** PUB-014, PUB-065 · **FEAT:** FEAT-055
**QA:** QA-CON-003 · **SBX:** SBX-028 · **Dep:** CAP-055 · **Milestone:** post-production
**Disposition:** `REQUIRED PLATFORM CAPABILITY WITH CUSTOMER-SPECIFIC CONNECTOR` · **Blocks:** — · **Approval:** per engagement

### 3.8 Cross-cutting quality

#### CAP-066 · Accessibility conformance
**Outcome:** every user, including keyboard-only and screen-reader users, can do their job. **Ev:** the source fails four measurable baselines · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **PUB:** PUB-060 · **FEAT:** FEAT-054
**Rules:** **SP-HR-3** visible focus · **SP-HR-4** accessible names · **SP-HR-5** keyboard-operable workflows · **SP-HR-6** programmatic status. Preserve the source's genuine strengths: modal focus trapping and Escape-to-close.
**QA:** QA-A11Y-001..016 · **SBX:** SBX-032, SBX-033, SBX-034 · **Dep:** all UI capabilities · **Milestone:** continuous
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** none

#### CAP-067 · Request efficiency and performance
**Outcome:** the product stays fast at real department scale. **Ev:** measured ~25–40× request amplification from one click · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **PUB:** PUB-017, PUB-046, PUB-060 · **FEAT:** FEAT-049
**Rules:** **SP-HR-2** — one action, one request; CI request budgets; server-side rate limiting; monitored requests-per-interaction.
**QA:** QA-PERF-001..011 · **SBX:** SBX-030, SBX-031 · **Dep:** all · **Milestone:** continuous
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** **PO-DEC-23** (performance targets)

#### CAP-068 · Privacy: no third-party identifier leakage
**Outcome:** using the product does not disclose who you are to third parties. **Ev:** hashed email sent to a third-party avatar service on every page load · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **FEAT:** FEAT-052
**Rules:** **SP-HR-1** — never transmit an email address, email-derived hash, or equivalent identifier to a third-party avatar service. Locally generated initials, org-managed uploads, or a privacy-reviewed first-party service. CI guard on new third-party hosts.
**QA:** QA-SEC-001, QA-SEC-002, QA-SEC-003 · **SBX:** — (`NOT APPLICABLE` — verified by automated CI network assertions, not a sandbox scenario) · **Dep:** all UI · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** none

#### CAP-050 · Design-system safety contract
**Outcome:** users never lose data to a surprising control. **Ev:** an "Add" control created a live record on one click — the research's only safety incident · **Class:** `SUPERSEDED SOURCE BEHAVIOUR` · **FEAT:** FEAT-047, FEAT-048
**Rules:** **no Add/New/Create control may persist data before a completed form, validation, and an explicit Save or confirmation.** Inspection and destruction never share a click target. Graduated confirmation friction scaled to blast radius (a genuine source strength, retained).
**QA:** QA-PICK-003, QA-REQ-006 · **SBX:** SBX-020 · **Dep:** all UI · **Milestone:** foundation
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** Beta · **Approval:** none

#### CAP-051 · Observability, backup, and recovery
**Outcome:** operators can see what is happening and restore it when it breaks. **Ev:** the source surfaces neither delivery status nor build diagnostics; a third-party widget failed silently on every page load · **Class:** `SCHEDULEPOINT DECISION` · **FEAT:** FEAT-045, FEAT-053
**Rules:** point-in-time restore; migration rehearsal; documented RTO/RPO; **audit history never lost**; alerting on request amplification, notification failure, and import quarantine.
**QA:** QA-CON-012, QA-CON-013, QA-CON-014 · **SBX:** SBX-035 · **Dep:** all · **Milestone:** beta
**Disposition:** `REQUIRED FOR PRODUCTION` · **Blocks:** **Prod** · **Approval:** none

---

## 4. Capability count and disposition summary

**58 capabilities** defined (CAP IDs in use: CAP-001..CAP-068; ten IDs within that range are intentionally unallocated and are not referenced anywhere — capability numbering is deliberately sparse so related capabilities sit in contiguous blocks by theme).

| Production disposition | Count |
|---|---:|
| `REQUIRED FOR PRODUCTION` | 47 |
| `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` | 4 |
| `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` | 4 |
| `REQUIRED PLATFORM CAPABILITY AND NAMED CONNECTOR` | 1 |
| `REQUIRED PLATFORM CAPABILITY WITH CUSTOMER-SPECIFIC CONNECTOR` | 1 |
| `ADMINISTRATIVE FALLBACK OR OVERRIDE` | 1 |

---

## 4a. Public claims with no capability mapping

Two public claims are **not product capabilities**. They are recorded as explicitly `NOT APPLICABLE` with a stated reason rather than left silently unmapped:

| Claim | Why no capability |
|---|---|
| **PUB-049** — cumulative picks completed and claimed customer time/cost savings | `NOT APPLICABLE` — a **marketing usage metric** about the vendor's installed base, not a product behaviour. It implies a cross-tenant aggregate counter, which SchedulePoint neither needs nor should build for healthcare tenants without an explicit privacy review. |
| **PUB-066** — designed by a physician; algorithms in use since 2003/2008, "verified for fairness" | `NOT APPLICABLE` — a **provenance and credibility claim**, not a capability. **No algorithm may be copied**; SchedulePoint's engine is independently designed ([21](21-automated-scheduling-production-requirements.md) §0). The *outcome* the claim implies — demonstrable fairness — is covered by CAP-045 and the quality criteria in [21](21-automated-scheduling-production-requirements.md) §7. |

**All other 68 public claims map to at least one capability.**

---

## 5. Blockers

Computed from the capability blocks above.

**Architecture blockers (7):** CAP-001, CAP-002, CAP-003, CAP-006, CAP-032, CAP-055, CAP-057.

**Beta blockers (15):** CAP-005, CAP-008, CAP-009, CAP-010, CAP-019, CAP-021, CAP-022, CAP-023, CAP-024, CAP-026, CAP-034, CAP-042, CAP-047, CAP-050, CAP-067.

**Production blockers (22):** CAP-003, CAP-013, CAP-014, CAP-015, CAP-016, CAP-017, CAP-020, CAP-027, CAP-030, CAP-031, CAP-032, CAP-033, CAP-040, CAP-041, CAP-045, CAP-046, CAP-051, CAP-058, CAP-059, CAP-060, CAP-066, CAP-068.

**Connector-release blockers (5):** CAP-055, CAP-061, CAP-062, CAP-063, CAP-064 — **no hospital connector ships until CAP-062's de-identification boundary is demonstrated with test evidence (SBX-029).**

---

## 6. External specifications required

| Capability | Specification needed | Normally provided by |
|---|---|---|
| CAP-061 ORSOS | payload contract, authentication, direction, scheduling | hospital IT + system vendor |
| CAP-063 Cerner/Surginet | as above | hospital IT + system vendor |
| CAP-064 Meditech | as above | hospital IT + system vendor |
| CAP-062 de-identification boundary | the customer's definition of identifying fields, plus governance sign-off | hospital privacy office |
| CAP-065 customer-specific connectors | per-engagement integration contract | customer |

**The absence of every one of these blocks connector release only — not architecture, not implementation, and not production of the core product.** The integration framework is built against a canonical internal schema and connectors adapt to it, so no hospital's IT timeline gates SchedulePoint's own release. See [23](23-pre-architecture-evidence-plan.md) §5.

---

## 7. Cross-references

- Contradiction resolutions — [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md)
- Scheduling engine specification — [21-automated-scheduling-production-requirements.md](21-automated-scheduling-production-requirements.md)
- Full traceability — [22-functional-traceability-matrix.md](22-functional-traceability-matrix.md)
- Evidence and environments — [23-pre-architecture-evidence-plan.md](23-pre-architecture-evidence-plan.md)
- Release gates — [24-production-completeness-gates.md](24-production-completeness-gates.md)
- Amended source reports — [12](12-product-glossary.md), [13](13-feature-inventory.md), [14](14-domain-model.md), [15](15-state-machines.md), [16](16-research-completion.md)
