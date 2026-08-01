# 05 — Independent Product Specification

**What SchedulePoint is, stated in my own structure, after independent review of the entire evidence base.**

**Relationship to report 19:** I audited the 58-capability production baseline capability-by-capability against the underlying evidence and against the Stage-4 checklist in my mandate, and **I ratify it as the scope authority**. This specification therefore does not re-transcribe 58 capability blocks; it organizes the product into twelve functional areas, states the product model in each, records per-area confidence and parity posture, and registers the deltas and sharpenings my review adds. Where a detail lives in the corpus, it is cited, not copied. Field-level detail: report 19 (per-capability), report 21 (engine), SPEC-01..16 (normative behaviour).

**Parity priority key:** P1 = exact behavioural parity intended · P2 = high functional parity (same outcome, own mechanism) · P3 = equivalent modern behaviour · P4 = intentional redesign. Per-capability assignments: [06-feature-parity-matrix.md](06-feature-parity-matrix.md).

---

## 0. Product purpose

SchedulePoint is a multi-tenant workforce-scheduling product for physician and anaesthesia groups. It generates fair, rule-compliant work schedules automatically; lets schedulers review, correct, and publish them as immutable versions; runs the group's time-off, extra-work, and shift-exchange economies; and coordinates the daily allocation of concrete work items (rooms/cases) through a turn-based real-time picklist with escalating notifications. It is a clean-room replacement for the observed product: every observed user outcome is preserved; no source implementation is copied; six observed source defects are deliberately not reproduced (SP-HR-1..6, I-13).

**The scheduling rule (I-05):** automated generation is the production mechanism. Manual scheduling exists, permanently, as override, recovery, fixed-assignment input, and development-stage fallback — never as the product's answer.

## 1. Tenancy, organizations, groups, entitlements

**Model.** `Organization` is the tenancy root and isolation boundary (CAP-001). `Group` is the scheduling scope: shift catalogue, schedules, requests, picklists, and settings are group-scoped; a user switches between groups they belong to (CAP-002). Site/physical-location is an attribute (`site_label`) pending PO-DEC-01, with both migration directions pre-modelled (CAP-004). Entitlements are first-class org-level records separate from permissions; module dependencies enforced; disabling a module hides behaviour and **never deletes data** (CAP-057, PO-DEC-04).

**Isolation (CAP-003, the platform's most load-bearing property):** client-declared, server-verified request context (SPEC-01 tuple; stale context is rejected with `409 CONTEXT_STALE`, never silently substituted) over transaction-local PostgreSQL RLS in a mandatory unit-of-work that fails closed. Multi-organization user accounts: **no** for first release (PO-DEC-06 default).

**States/failure:** entitlement expiry → module unavailable, data retained; membership suspension → deny before any allow (SPEC-06 P-2). **Audit:** all entitlement and membership changes. **Confidence:** High (design); source behaviour Confirmed for group switching. **Parity:** P2 overall; CAP-003/057 are P4 (no observable source equivalent — retrofit-impossible, so built first).

## 2. Identity, accounts, roles, permissions

**Model.** `User` (account, immutable id; `login_email` changeable only by admin capability or IdP, all sessions invalidated — CAR-027) · `Membership` (user × group) · **role lives on membership, not account** — the research's single most important structural finding, Confirmed. Account types distinguish person vs. functional accounts (C-06). Staff and Locum are membership kinds with scheduling consequences (locums excluded from fairness credits by default, staff-over-locum priority window — CAP-025).

**Authorization (PO-DEC-02, approved):** four ordered layers — org entitlement → group/module availability → membership role → explicit action capability — evaluated by one pure evaluator against a normative truth table (SPEC-06); deny-by-default (I-02); explicit deny beats every allow; entitlement precedes permission; freshness via version counters + 30s TTL; jobs and socket frames re-authorize. **No permission flag ships without a tested capability difference** — the C-02 lesson.

Roles (from the six observed Access Levels, normalized): **Member** (staff/locum daily use), **Viewer** (read-only), **Telecom** (on-call board only — CAP-044), **Scheduler** (scheduling + approvals + picklist admin), **Group Admin** (config + membership), **Org Admin** (entitlements, groups, identity). Named capabilities layer on top per SPEC-06. Impersonation: audited, banner-visible, time-limited, barred from credential screens (CAP-010, PO-DEC-11). Proxies: first-class grants; default scope act-on-behalf, fully attributed (CAP-034, PO-DEC-19).

**Authentication (CAP-008/009):** first-party email+password with MFA (TOTP minimum; required for elevated roles), per-org OIDC SSO with `iss` pinning (T-26), server-side sessions with idle+absolute lifetimes, invitation/activation separated from password reset. This deliberately exceeds the observed source (PO-DEC-09 pending). **Confidence:** roles-as-observed Confirmed for Scheduler, Inferred for others — which is precisely why SchedulePoint defines its own tested model rather than replicating flags. **Parity:** P4 (intentional redesign, outcome-preserving).

## 3. Scheduling structure: shifts, groups, FTE, eligibility

**Model.** `ShiftType` catalogue with the four orthogonal observed flags — on-call, manual-only, daily-pick, stipend — controlling where a type surfaces product-wide (CAP-011, Confirmed). `ShiftGroup` (scoring mode + weight; `allowRequest` is a genuine server-side filter) and `StaffGroup`; valid-group combinations constrain assignment (CAP-012). Weekday-variable FTE, maximum assignments, and work percentage as canonical effective-dated tables (`membership_work_profiles`, `membership_weekday_fte` — CAP-013, CAR-006). Qualifications/credentials with evidence reference and expiry gate eligibility (CAP-058, PO-DEC-12 — patient-safety adjacent, administrator-granted).

**Validation:** effective-dating everywhere; no deletion of referenced catalogue rows (archive instead). **Audit:** all catalogue and profile changes. **Confidence:** Confirmed (config surfaces were fully inventoried at field level, Phase 6). **Parity:** P2.

## 4. Schedule generation (the engine)

Report 21 + SPEC-04 + doc 08 govern; independent summary and plan in [12-scheduling-engine-plan.md](12-scheduling-engine-plan.md).

**Model.** A build consumes: period (Mon-start/Sun-end, Confirmed), demand (shift requirements per day), people (eligibility, FTE targets, profiles), rules, request/vacation constraints, and pinned assignments. Rules are a **typed, versioned AST with a closed node set** — pattern rules (shift-scoped spacing/sequencing), staff rules (named-individual constraints, five action types), position restrictions, group weighting — each expressible as **hard constraint or weighted preference** (Confirmed as a source concept; our formalization). Hard/soft is enforced in data, compiler, and by independent re-validation of returned solutions; a hard violation in output is a build-rejecting defect, not a warning.

**Build lifecycle:** 16 states (report 21) distinguishing `infeasible` (proven impossible; produces a bounded explanation, never a bare flag) from `failed` (engine error). Progressive builds fill around pinned/protected assignments (CAP-017). Explainability: four bounded tiers with `EXPLANATION_BUDGET_EXCEEDED`/`EXPLANATION_UNAVAILABLE` as honest states. Reproducibility: seed, solver version/image digest, worker count, compiler version recorded per build; what is *not* promised across upgrades is stated. Quality: twelve acceptance criteria with configurable thresholds; conflict severity taxonomy per PO-DEC-13.

**Confidence:** the source algorithm is Unknown, permanently; this is SchedulePoint's own model (clean-room posture stated in every governing doc). **Parity:** P2 for outcomes (a scheduler gets a fair, rule-compliant, explainable schedule); mechanism is ours by necessity.

## 5. Schedule presentation, manual control, publication

**Model.** Staff × date grid in three views (date/staff/shift), virtualized to ≥200 staff × 8 weeks; **assignment and fairness credit move independently** per cell (Confirmed — a source idea worth keeping); per-cell provenance log; daily assignment sheet; a screen-reader-first tabular alternative to the visual grid (SPEC-14). Manual assignment/override obeys every server-side eligibility check and is audited with mechanism = manual (CAP-019).

**Publication (CAP-014, SPEC-05):** identity/snapshot separation (`assignment_identities` + `assignment_snapshots`); versions are immutable once published, enforced by database triggers (I-18, D-15); publication is idempotent, produces exactly one current version (D-16/17); supersession publishes forward — **revert exists and never deletes history** (the source has no rollback at all; P4 divergence). Locks: `lock_state` on versions, `is_pinned` on snapshots. Partial-schedule circulation supported (CAP-018). Affected-staff diff notification on publication (CAP-027).

**Confidence:** grid/editor Confirmed; publication semantics our design. **Parity:** grid P1-adjacent P2; versioning P4.

## 6. Requests, vacation, time off

**Model (SPEC-08, ADR-0016, provisional under PO-DEC-03).** One `Request` aggregate; five constrained subtypes (ON, OFF, No-Call, shift preference, vacation-linked) with per-subtype status domains enforced by CHECK constraints (D-18..20). Terminal facts split honestly: `consumed_by_build` / `reflected_in_version` / `unsatisfied` — a request is never just "applied". Shift preferences are `accepted_as_input`, never "approved". Group-wide Request-Until-Date gates submission (Confirmed).

**Vacation (CAP-022/023):** quota/grant mode (default) and open mode; Monday-start/Friday-end blocks (Confirmed); weekly org capacity; individual and batch approval; **over-quota approval is advisory, not blocking — red variance indicator, audited override** (Confirmed source behaviour, deliberately preserved); racing approvals of the last unit resolve to exactly one winner (D-21 conditional allocation); commit-to-schedule is idempotent and **reversible via `reversed` state and forward revision** — the observed irreversible type-"PUBLISH" transfer keeps its graduated-friction UX (worth keeping) but not its irreversibility (P4). Withdrawal after reflection raises a revision request rather than silent divergence.

**Confidence:** vacation lifecycle Confirmed; ON/OFF surfaces partially Inferred (creation surface never located — gap #11, replaced by our own UI). **Parity:** P2.

## 7. Marketplace: opportunities, offers, swaps, transfers

**Model (SPEC-13).** Opportunity board: one-to-many give-away with email fan-out to eligible members (opt-out honoured, PO-DEC-15), staff-over-locum priority window (default 24h, PO-DEC-16), atomic first-accept claim. Swaps/transfers: directed, counterpart acceptance always required, scheduler review configurable per group (PO-DEC-17). **Every claim binds `assignment_identity_id` + source version + snapshot; a claim racing a republication fails `STALE_ASSIGNMENT`** rather than transferring a stale snapshot; eligibility re-checked inside the claim transaction; deterministic lock order; deadlock retry reuses `command_id` so retries cannot duplicate notifications (D-24). Transfers produce a new schedule version — published versions are never edited.

**Confidence:** opportunity structure Confirmed; swap lifecycle Unknown at source (form observed only) — ours is a design, flagged as such. **Parity:** P2; version binding is P4 rigor with no source equivalent.

## 8. Picklist (daily draft)

Full plan: [13-picklist-plan.md](13-picklist-plan.md); normative: SPEC-02, doc 10.

**Model.** Per-day, turn-ordered draft where participants (or proxies) select work items. Preparation: work-item import through the ingestion boundary or manual creation under the controlled vocabulary, pick order **derived from the Master Schedule and not editable in the manager** (Confirmed), lock, three operating modes — paper, manual-entry, integrated (CAP-060). Execution: server-authoritative turn state and clock (I-08); one authoritative transaction per turn resolution; **at most one accepted selection per turn (D-3a), one claimant per item (D-3b), one open turn (D-3c)**; command idempotency; gapless event log; coordinator lease + fencing tokens — coordinators relay the durable log and never generate events. Timers with escalation ladder (§9); pause/resume/skip; administrator intervention audited per action; post-completion correction is a separate audited operation, never an in-place edit. Completion publishes daily assignments.

**Turn-critical state is pushed (PO-DEC-18):** version tokens, reconnect/resync, visible staleness, explicit refresh fallback, page-scoped connections only. Accessibility of the live turn is a first-class acceptance requirement (AX-1..5): focus stolen only when the turn becomes yours; bursts coalesced; a timed turn must be completable via AT or the allowance changes.

**Confidence:** the least-evidenced major subsystem — execution never observed (Unknown). Everything above is SchedulePoint's own design, proven by SBX-020..027/033 before beta. **Parity:** P2 on outcome; mechanism necessarily P4.

## 9. Notifications and communications

**Model (SPEC-07).** Four separated concepts: intent → logical delivery → attempt → provider callback. Transactional outbox; dispatch only after commit (I-11). Channels: email, SMS, voice, push — all behind ports; push stores envelope-encrypted full subscription material retrievable only by the delivery role (CAR-009). Delivery guarantee stated exactly: **domain state exactly-once; external delivery at-least-once with recorded `ambiguous`/`unresolved` outcomes** (I-20). Escalation ladder: two-window model (mandatory + personal), four channels, acknowledgement as durable state, steps dispatch through conditional claims. Notification-class matrix separates safety-critical/security (quiet-hours-overriding, non-disableable) from suppressible classes. `no-destination` is an explicit outcome. A per-user delivery log exists — the source has none (P4).

Contacts directory with **minimised PII** (role-appropriate field visibility — diverging from the source's blanket exposure of personal phones; CAP-042, PO-DEC-20). Bulk messaging to staff (CAP-043); group communication identity outbound-first (CAP-056, PO-DEC-21). **Parity:** P2/P4.

## 10. Reports, statistics, documents, calendar

**Model (SPEC-09).** Six report classes (Confirmed count) regenerated as: async jobs producing stored artifacts; every report binds an immutable input snapshot (version id / as-of txid / input manifest+hash) and the `policy_version`; authorization evaluated at request, execution, and every download; shares target memberships, never addresses; lost artifacts regenerable from manifests. Fairness statistics and variance visible to schedulers — the formula is ours and documented, not hidden (CAP-045, RISK-18). Calendar feeds: server-rendered iCalendar, hash-stored revocable high-entropy tokens, **no PII or bearer token in URLs** (P4 vs. the observed leak), per-fetch authorization, `no-store` headers. Document repository: categories, size/type constraints, org-scoped, policy-driven retention (PO-DEC-22). Calendar events on the schedule (CAP-049). Printing via report artifacts.

**Confidence:** report internals mostly Unknown (4 of 6 dialogs never opened) — ours is a coherent redesign. **Parity:** P2/P3.

## 11. Integrations and ingestion privacy

**Model (SPEC-03, ADR-0021, PO-DEC-08 approved).** Hospital surgical-booking integration framework: canonical internal schema owned by the platform; per-vendor adapters (Cerner/Surginet, Meditech, customer-specific) each gated on an external specification (EV-1) — **a missing connector blocks that connector, never the product**. The raw-ingress enclave sits ahead of all observability and durable infrastructure: no body logging, no payload persistence, no DB credential, egress allowlisted; replay re-fetches from source. Every accepted field has type/shape/controlled-vocabulary constraints; label/location refs must resolve to approved rows; **rejection, never sanitization**; quarantine stores field paths/codes/counts — never values, never hashes. Free text is removed from protected work-item paths (RISK-30 acknowledged: the answer to scheduler pushback is a better vocabulary workflow, not free text). **No patient-identifying information enters the platform (I-07/I-17); no patient-level entity exists in the domain model** — the user outcome (staff see where to be, with operationally sufficient labels) is preserved via CAP-030/033/060.

**Parity:** P4 by design — this is the highest-consequence divergence and it is the point.

## 12. Cross-cutting product behaviour

- **Audit (CAP-027/051):** every mutation audited with actor, on-behalf-of, before/after, mechanism, correlation id (I-06); append-only with hash chain + signed checkpoints (A1) → external write-once replication (A2) by G-PROD; 7-year default retention, legal hold, anonymisation-not-deletion.
- **Idempotency and amplification (SP-HR-2, I-09/I-10):** idempotency keys on every mutation; requests-per-interaction is a CI-enforced budget metric.
- **Dates and time (A-07):** ISO-8601 canonical, explicit group timezone, DST-correct, overnight shifts well-defined — replacing the source's timezone-naive three-format behaviour (P4).
- **Accessibility (CAP-066, SPEC-14):** SP-HR-3..6 as invariants (I-12); component × property acceptance matrix; eight AT/browser combinations claimed only with retained manual evidence.
- **Design-system safety (CAP-050, I-13):** no Add/New/Create control persists before a completed form and explicit Save; confirmation friction scales with blast radius, up to type-the-word confirmation for irreversible-feeling operations (the one source UX pattern explicitly worth replicating).
- **Error/empty/loading states:** every list and workflow ships loading, empty, success, error, and permission-denied states (definition-of-done item; the source's error behaviour was unobservable, so ours is designed, not copied).
- **Performance (CAP-067):** deliberately conservative published targets (report 21 §8.3, PO-DEC-23); the public speed claim is never repeated as ours; solver speed is never reported without its paired quality measure.
- **Responsive behaviour:** the grid, picklist, and request flows fully usable at phone width; no page-level horizontal overflow (diverges from observed Contacts defect).

## 13. Deltas this specification adds to the corpus

1. **Role-name normalization** (§2) — the corpus keeps observed Access-Level names; I define the shipped role set and its mapping, resolving the Genius-vs-Scheduler unknown by *not shipping* an untestable distinction (consistent with PO-DEC-02's no-untested-flags rule).
2. **Error/empty/loading states as universal definition-of-done items** (§12) — present in the playbook appendix, absent from the capability baseline's field sets; now binding via the runbook.
3. **Explicit parity postures per area** (P1–P4) — the corpus classifies dispositions (what ships) but not fidelity intent (how alike it must feel); [06](06-feature-parity-matrix.md) completes this.
4. **The three schema-stage proof harnesses elevated to product-spec status** (§§1, 5, 8): tenant isolation, publication immutability, and turn atomicity are *product promises*, not implementation details, and appear in acceptance criteria accordingly.
