# 16 — Research Completion and Handoff

**Phase:** 13 — final consolidation. **Audience:** product definition and architecture stages.

This is a **handoff summary, not a digest** — it does not reproduce the other reports. Where detail matters, it points to where that detail lives. Read this first, then follow the cross-references.

---

## 1. Research scope

A clean-room product investigation of **https://ischedule.md**, a physician/anaesthesia workforce-scheduling SaaS, conducted so that an independently designed replacement product — **SchedulePoint** — can support the same *categories of user need* without copying source code, assets, data, or design.

**Covered:** the complete navigable surface of a live production tenant, reachable by a Scheduler-level account across two group memberships — 34 screens, 23 user workflows, 5 request/vacation lifecycles, the full scheduling-engine configuration surface, the picklist system, supporting modules, responsive and accessibility behaviour, and externally observable technical behaviour.

**Not covered, by design:** source code, database schema, API response bodies, any authenticated surface requiring a role other than Scheduler, and every behaviour that could only be established by performing a mutating action.

**Thirteen phases** produced sixteen reports, four maintained index files, and a Git history with a checkpoint per phase.

---

## 2. Research method and safety boundary

All navigation was **strictly read-only**, governed by [RESEARCH-RULES.md](../RESEARCH-RULES.md). Prohibited throughout: creating, editing, saving, submitting, approving, publishing, deleting, importing, uploading, sending, impersonating, or changing any setting; testing authorization boundaries; replaying or constructing requests; and capturing credentials, tokens, cookie values, patient information, or unnecessary personal data.

Evidence was gathered by ordinary navigation plus **passive inspection** — reading the DOM, `href` attributes, computed styles, hidden dialog markup, and the browser's own network log. This technique repeatedly resolved open questions **without clicking anything**: it identified the Master Schedule's five report dialogs (Phase 10), confirmed a real-time hub exists without ever triggering a picklist (Phase 11), and produced all seven new findings in the final coverage audit.

**One safety incident occurred, in Phase 8.** A control labelled "Add Room" created a real record in a live picklist immediately on click, with no draft state or confirmation — contrary to every comparable control observed in seven prior phases. It was identified and deleted within the same tool-call sequence and verified restored to its exact prior state. It is documented in full in [07-picklist-system.md](07-picklist-system.md) §0 rather than minimised, and it produced a genuine product finding (FEAT-048) plus a permanently strengthened safety boundary for all later phases.

A second judgement call arose in the coverage audit: a **live picklist was discovered** in the account's other group. Per that phase's explicit brief, it was recorded and **deliberately not investigated** — see §18.

---

## 3. Final coverage-audit conclusion

**COVERAGE AUDIT PASSED WITH NON-BLOCKING GAPS.**

A dedicated reconciliation pass ([final-coverage-audit.md](final-coverage-audit.md)) swept the global navigation, every documented screen, and both group memberships, comparing them against the eleven-phase inventory.

- **No missing top-level module.** Identical 22-route navigation parity confirmed across both groups.
- **Seven additional subordinate surfaces documented** (CAL-01, SM-10..SM-14, NAV-03), all found by passive inspection with no clicks.
- **Zero** new admin areas, role-visibility changes, or broken/orphaned pages.
- Remaining gaps were already known, already named, and explicitly out of scope for a coverage pass to close.

---

## 4. Confirmed product capabilities

Full detail: [13-feature-inventory.md](13-feature-inventory.md) — **46 deduplicated features**.

The product is a **rules-driven schedule generator wrapped around a turn-based drafting mechanism**, with five capability clusters:

1. **Schedule generation** — a staged, versioned, chainable build pipeline (Setup → Planner → Build → Fix Picks → Publish → Lock) consuming a three-layer rule engine: pattern rules (shift-scoped spacing), staff rules (named-individual constraints with five action types), and position restrictions.
2. **Schedule presentation and correction** — a staff × date grid in three views, with a per-cell editor that moves *shift assignment* and *fairness credit* **independently**, backed by a per-cell provenance log.
3. **Time-off** — a vacation subsystem with weekly entitlement, org-wide weekly capacity, individual and batch approval, and a one-way commit into the schedule; plus shift-group-scoped "OFF {X}" requests.
4. **Shift marketplace** — an opportunity board (one-to-many give-away) and a swap mechanism (directed).
5. **Picklist drafting** — the signature feature: a per-day, turn-ordered draft where staff select work items, driven by a four-channel escalating notification ladder with proxy delegation.

Supporting: contacts directory with bulk messaging, document library, six report types, calendar-feed subscription, and a live monitoring dashboard.

---

## 5. Confirmed and inferred user roles

Full detail: [02-role-permission-matrix.md](02-role-permission-matrix.md), [12-product-glossary.md](12-product-glossary.md) TERM-010..018.

**Six Access Levels — OBSERVED:** Staff, Locum, View, Telecom, Scheduler, Genius.

**The single most important structural finding of the research: role is scoped per group membership, not per account.** The same individual (matched by identical email) was observed holding *different* Access Levels in each of two groups, corroborated across multiple distinct people. This is `OBSERVED`, high confidence.

Layered on top: **eight independent permission flags** that vary independently of role.

**Confidence boundary — important.** Every capability listed for **Scheduler** is directly observed. Every capability attributed to **Staff, Locum, View, Telecom, or Genius is INFERRED** from flag patterns, UI copy, and cross-group comparison. **No session was ever conducted as any role other than Scheduler**, and impersonation was prohibited. Whether Genius carries any capability beyond Scheduler is `UNRESOLVED`.

---

## 6. Confirmed business workflows

Full detail: [03-user-workflows.md](03-user-workflows.md) (WF-01..23), [06-requests-vacation-opportunities.md](06-requests-vacation-opportunities.md) (LC-01..05), [15-state-machines.md](15-state-machines.md) (STM-001..021).

**Well evidenced:** group switching; personal and organisation schedule viewing; vacation request creation, withdrawal, individual and batch approval, and commit; request status history; opportunity posting and retraction; per-cell schedule correction with audit; notification and proxy configuration; calendar subscription; profile, password, and default-group management.

**Structurally evidenced but behaviourally unresolved:** shift swap (form observed, lifecycle unknown), picklist execution (never observed live), build execution (never run), and login/password reset (deliberately never observed).

---

## 7. Confirmed business rules

- Role is per-membership; admin-surface access is gated by Access Level, **not** by the `Picklist Admin` flag (this is contradiction **C-02**).
- Shift types carry four orthogonal flags — on-call, manual-only, daily-pick, stipend — that determine where each type surfaces product-wide.
- Fairness scoring is three-layered: shift-group weighting, pattern rules, and named-individual staff rules, each expressible as a **hard constraint** or a **weighted preference**.
- Vacation blocks must start on a Monday and end on a Friday; build periods start Monday, end Sunday.
- **Over-quota vacation is advisory, not blocking** — the variance indicator turns red but does not prevent approval. A deliberate design choice.
- The pick-position count is group-wide and **monotonically increase-only** — positions can never be removed.
- Pick order is derived from the Master Schedule and is explicitly not editable in the Picklist Manager.
- Confirmation friction scales with blast radius, culminating in a **type-the-word-"PUBLISH"** confirmation for the irreversible vacation commit. **This pattern is worth replicating.**
- Requests are gated by a group-wide "Request Until Date"; shift groups carry an `Allow Request` flag that is a genuine server-side filter.

---

## 8. Confirmed technical observations

Full detail: [10-technical-observations.md](10-technical-observations.md).

Server-rendered multi-page application on an ASP.NET-family backend; jQuery 1.9.1, Bootstrap 3.4.1, Kendo UI 2014.2.1008, SignalR. Every navigation is a full page load; no client-side router; no client-side caching across navigations. Group context is carried **redundantly in three places at once** (URL hash, query parameter, and cookie). A SignalR hub named `picklist` connects on **every** page load, including pages with no live feature, and negotiates to long-polling. Three different date-serialization formats coexist across sibling endpoints. `localStorage` and `sessionStorage` are entirely unused — a conservative, low-attack-surface choice. The session cookie is not script-readable (a genuine positive).

**All API observations are sanitized** — no live identifier, token, or cookie value was ever recorded.

---

## 9. Known source-product defects

Six, catalogued as `SOURCE DEFECT — DO NOT REPLICATE`:

| ID | Defect | Consequence |
|---|---|---|
| FEAT-048 | "Add" control commits a live record on a single click, no draft stage | **Caused the only safety incident of the research.** Contradiction C-05 |
| FEAT-049 | One row selection fired **~25–40 identical requests** from two code paths | Wasted capacity; invisible without traffic inspection → **SP-HR-2** |
| FEAT-052 | A hashed email identifier sent to a third-party avatar service on **every page load, every user**, no consent | Reversible via public lookup; leaks "this email uses this healthcare product" → **SP-HR-1** |
| FEAT-047 | Clicking a status badge — the natural "view details" gesture — opens a **delete confirmation** by default | No neutral inspection path exists |
| FEAT-053 | Embedded support widget returns HTTP 503 on every page load, silently, with no fallback | A support channel invisibly unavailable |
| FEAT-054 | Accessibility baseline failures (see §10) | → **SP-HR-3..6** |

**Two additional structural gaps** (not defects, but absences with real consequences): there is **no rollback or unpublish control anywhere in the product**, and there is **no notification delivery log, status, failure, or retry indicator anywhere**.

---

## 10. Accessibility findings

Full detail: [09-responsive-accessibility.md](09-responsive-accessibility.md) (RA-01..19, F-01..08).

**Concrete, reproducible failures:** global `outline-style: none` with no replacement indicator on every element sampled; icon-only Prev/Next date-navigation buttons with **no accessible name**, on nearly every schedule screen; **zero `h1`/`h2`/`h3`** on the product's busiest page; 8 of 9 dialogs lack `aria-labelledby` and none sets `aria-modal`; request status conveyed by **fill colour alone**; no skip link (11+ tab stops before content on every page load); page-level horizontal overflow on Contacts at phone width with no scroll affordance.

**Genuine strengths worth preserving:** modal focus trapping and Escape-to-close both work correctly; focus order is logical; real `<th>` elements exist; the responsive sidebar breakpoint works; toolbars wrap gracefully.

**No WCAG conformance claim is made about iSchedule.MD** — these are individually evidenced observations only.

---

## 11. Privacy and security findings

- **Third-party identifier leak** — FEAT-052, the most significant privacy finding.
- **PII and a bearer token in a URL query string** — the calendar feed URL carries the user's email address *and* a long-lived token. URLs land in server logs, browser history, and `Referer` headers.
- **Broad PII exposure** — personal mobile, home phone, and personal email are visible across Contacts, On Call, and the admin roster with no evident field-level minimisation.
- **Clinical case detail present** — patient age indicators and procedure descriptions appear on personal daily views. Confirmed present; **never transcribed into any research artifact**.
- **Impersonation exists** (`Sign In As`) with **no evidence of any audit trail**.
- **A vendor-domain account** sits inside the customer's user roster.
- **Positives:** the session cookie is not script-readable; browser storage is unused; no analytics or session-replay tooling ships.
- **Untested by instruction:** server-side authorization, anti-forgery mechanics, session timeout, and every authorization boundary.

---

## 12. SchedulePoint hard requirements

Non-negotiable, carried into every downstream document:

| ID | Requirement | Origin |
|---|---|---|
| **SP-HR-1** | Never transmit an email address, email-derived hash, or equivalent identifier to a third-party avatar service. Use local initials, org-managed uploads, or a privacy-reviewed first-party service. | Diverges from FEAT-052 |
| **SP-HR-2** | One user action produces one intended request or one idempotently handled operation. No accidental amplification, no duplicate effects. | Diverges from FEAT-049 |
| **SP-HR-3** | Every interactive element has a clear, visible keyboard-focus indicator. | Diverges from RA-07 |
| **SP-HR-4** | Every interactive control, including icon-only controls, has a meaningful accessible name. | Diverges from RA-13 |
| **SP-HR-5** | All critical workflows are fully keyboard-operable. | RA-11 (never ruled out in source) |
| **SP-HR-6** | Errors, validation results, status changes, and confirmations are communicated programmatically to assistive technology. | RA-17 (never observable in source) |

**Carried architectural requirements** (design deliberately, do not inherit): server-side **and** database-supported tenant isolation; versioned and auditable published schedules; server-enforced state transitions; concurrency protection; idempotent operations; complete audit history; **and no patient-level information in the MVP unless explicitly approved.**

---

## 13. Recommended MVP scope

25 features. Critical path: **tenancy → authentication → users/roles → shift catalogue → eligibility & rules → build → schedule grid → publication → versioning.**

Tenancy and identity (FEAT-001, 002, 003, 005, 007, 008) · shift and schedule structure (FEAT-010, 011, 012, 013, 014, 015) · generation and publication (FEAT-016, 017, 018, **019**) · time off (FEAT-020, 021, 022) · fairness (FEAT-023) · correction and audit (FEAT-027, **045**) · operations (FEAT-033, 040, 041-directory).

**FEAT-002 (Organization), FEAT-003 (server-enforced isolation), FEAT-019 (versioned schedules), and FEAT-045 (audit) have no source equivalent** and are included because retrofitting any of them later is prohibitively expensive.

**The picklist is deliberately excluded from the MVP.** It is the source product's signature feature, but it is also the least-evidenced part of the research, carries the severest concurrency requirements, and is blocked by both unresolved contradictions. A schedule is useful without it; it is not useful if built on guesses.

---

## 14. Recommended post-MVP scope

Ten features: picklist preparation, staff-facing participation, execution, and monitoring (FEAT-030, 031, 032, 035) — sequenced first, after a live-simulation environment exists; opportunity board (FEAT-025); reports and statistics (FEAT-024); calendar subscription, redesigned (FEAT-042); document library (FEAT-050); calendar events (FEAT-046); bulk messaging (FEAT-041).

---

## 15. Excluded or deferred features

**Excluded:** clinical case detail (FEAT-051) — a scheduling product carrying patient data inherits clinical-system obligations without clinical-system controls. Also excluded: the product tour (loaded on every page across twelve phases, **never once fired**).

**Deferred pending a decision** (§16): Site modelling, impersonation, shift swap, proxy delegation.

**Not carried forward at all:** the increase-only pick-position constraint; the irreversible vacation transfer *mechanism* (the capability is kept, made idempotent and reversible); the `jobs` API resource, whose purpose was never established.

---

## 16. Product-owner decisions required

| # | Decision | Blocking? | Recommendation |
|---|---|---|---|
| **C-02** | Picklist administration permission model | **YES — blocks picklist work** | Role + granular grants, **every grant authorization-tested**. Ship no vestigial flag. Copying the source model is rejected. |
| **C-03** | One Request entity or two | Blocks request domain model | One entity, typed, one lifecycle, multiple views |
| D-01 | Does Site exist in the MVP? | No | Defer |
| D-04 | Proxy scope: notifications-only vs. acting authority | Blocks proxy work | Model both explicitly; ship notifications-only first |
| D-05 | Offer/swap acceptance and approval model | Blocks marketplace | Counterpart acceptance required; scheduler approval configurable |
| D-06 | May one User belong to multiple Organizations? | No | No, for the MVP |
| **C-06** | Directory membership vs. user roster (~30–35% gap, both groups) | No | Explicit account types with explicit directory rules |

---

## 17. Architecture decisions required

| # | Decision | Blocking? | Recommendation |
|---|---|---|---|
| **C-04** | Real-time vs. polling for picklist state | **YES — blocks picklist architecture** | **Split:** push for turn-critical state, explicit refresh for administrative lists; connections scoped per page, not opened globally |
| A-01 | Tenant isolation enforcement mechanism | Yes | Server-side **and** database-level; deny-by-default; a route without an explicit policy fails the build |
| A-02 | Concurrency strategy | Yes | Optimistic concurrency per record; period-scoped serialisation for publication; atomic conditional claims for scarce resources |
| A-03 | Idempotency mechanism | Yes | Idempotency keys on every mutation (**SP-HR-2**) |
| A-04 | Audit storage and query model | Yes | Append-only, queryable, org-scoped, never embedding PII in payloads |
| A-05 | Schedule versioning and revert | Yes | Immutable versions; revert publishes forward, never deletes history |
| A-06 | Notification delivery, retry, dead-lettering | Yes | Transactional outbox; dispatch only after commit; explicit `no-destination` outcome |
| A-07 | Date, time, and timezone handling | Yes | ISO 8601 canonical; explicit group timezone; DST-correct; **the source is timezone-naive with three coexisting date formats** |

---

## 18. Remaining evidence gaps

Fourteen carried forward. In priority order:

1. **Live picklist execution** — current picker, timers, room-selection UI, confirmation, failure/retry, skip, pause/resume. **The largest gap in the entire effort.** No draft was ever open across twelve phases; when one finally *was* open during the coverage audit, it was **deliberately not investigated** per that phase's explicit brief. Only the aggregate "pick N of M" progress state is confirmed.
2. **Real-time concurrency** — connection loss, multi-tab, concurrent selection, stale state. Requires a live draft plus a second session.
3. **Lower-privileged role views** — no session other than Scheduler was ever available.
4. **Form validation and error presentation** — no form was ever submitted, so no error state exists anywhere in the evidence base.
5. **Report dialog internals** — 4 of 6 types never opened.
6. **Build execution and failure states** — no build was ever run.
7. **Notification delivery behaviour** — no log exists in the product to observe.
8. **Session/idle timeout** (#75) and **anti-forgery mechanics** (#76) — never observable without a POST.
9. **SignalR message payloads** (#72) — hub confirmed; messages never observed.
10. **Duplicate-request root cause** (#74) — effect measured; cause needs source access.
11. **Request creation surface for "OFF {X}"** (#16/#30/#47) — never located after four phases.
12. **Zoom and reflow** (#70) — never tested.
13. **Contacts filter rule** (#60) — corroborated across both groups; rule still unknown.
14. **The two unopened PDFs** — never opened by instruction in every phase.

**None blocks product consolidation.** Every one is represented as a named future SchedulePoint test in [11-edge-cases-and-qa.md](11-edge-cases-and-qa.md).

---

## 19. Required future test environments

| Env | Provides | Purpose | Blocks |
|---|---|---|---|
| **MULTI** | **multiple organizations or tenants** | ≥2 organizations, one shared user holding differing roles in each | Tenant isolation, IDOR, cross-tenant leakage |
| **CONC** | **multiple simultaneous users** and **controlled concurrency testing** | 2+ genuinely concurrent authenticated sessions with orchestrated timing | Concurrency, races, optimistic-concurrency conflicts, atomic claims |
| **LIVE-SIM** | a **simulated live picklist** | controllable clock, controllable network, scriptable turn advancement | **Gap 1 above — the largest remaining gap** |
| **PERF** | **performance testing** | load and scale harness with instrumented telemetry | **SP-HR-2**, N+1, request budgets, real-time connection cost |
| **A11Y** | **accessibility testing** | screen readers, forced-colors, browser zoom, real devices | **SP-HR-3, SP-HR-4, SP-HR-5, SP-HR-6** |
| **DR** | **disaster-recovery testing** | restore and migration rehearsal | Backup, point-in-time restore, RTO/RPO |

**No test in the catalogue may run against iSchedule.MD, ever.** Several classes must never run against *any* production environment — see [11-edge-cases-and-qa.md](11-edge-cases-and-qa.md) §14.10.

---

## 20. Recommended next phase

**Product reconciliation and product-owner decisions — not application coding.**

Suggested order:
1. Resolve **C-02** and **C-04** — both block downstream work and neither can be resolved by further research.
2. Resolve C-03, D-01, D-04, D-05, D-06.
3. Ratify the MVP scope in §13 and the hard requirements in §12.
4. Only then begin architecture (§17), and only after that, implementation.

**Do not begin repository scaffolding, interface design, or implementation until §16 and §17 are settled.** The research has deliberately stopped short of all four.

---

## 21. Research-completion declaration

- **Broad research against iSchedule.MD is complete.** Thirteen phases, sixteen reports, four maintained indexes, a Git checkpoint per phase.
- **The final coverage audit found no missing top-level module.** Navigation parity was confirmed across both group memberships.
- **Seven additional subordinate surfaces were documented** (CAL-01, SM-10..SM-14, NAV-03), all via passive inspection with no clicks.
- **An active picklist was observed but deliberately not opened**, per that phase's explicit brief — recorded, not investigated.
- **Live picklist execution remains the largest observational gap**, unchanged.
- **The remaining gaps do not block product consolidation.** All fourteen are named, tracked, and mapped to future tests.
- **SchedulePoint must be a clean-room, independently designed product.** No source code, markup, asset, schema, or design was copied at any point. Where this research recommends preserving a source *idea* (the credit/assignment split, graduated confirmation friction, per-cell provenance, the two-window notification model), it preserves the idea, never an implementation.
- **The next phase is product reconciliation and product-owner decisions, not application coding.**

**Research status: COMPLETE.**

---

### Phase 13 deliverables

| Report | Contents |
|---|---|
| [12-product-glossary.md](12-product-glossary.md) | 75 terms (TERM-001..075) |
| [13-feature-inventory.md](13-feature-inventory.md) | 46 features (FEAT-001..054) |
| [14-domain-model.md](14-domain-model.md) | 44 entities (ENT-001..040), ERD, 5 matrices |
| [15-state-machines.md](15-state-machines.md) | 21 lifecycles (STM-001..021), 11 diagrams |
| 16-research-completion.md | This handoff |

**Contradictions carried forward: 7** (C-01..C-07). **C-02 and C-04 remain explicitly unresolved and blocking.**
