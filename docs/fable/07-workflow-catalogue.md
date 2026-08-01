# 07 — Workflow Catalogue

**Every user-facing workflow SchedulePoint ships, organized by actor, with evidence grade and where its normative behaviour lives.** Detailed step evidence: reports 03 (WF-01..23), 04, 06 (LC-01..05), 07; lifecycles: [10-state-machines.md](10-state-machines.md). Evidence grade: **C** = Confirmed at source · **I** = Inferred at source · **D** = SchedulePoint's own design (source unobservable). Every workflow, regardless of grade, gets loading/empty/error/permission-denied states, keyboard operability (SP-HR-5), audit events, and an idempotent server transition — these are definition-of-done items, not per-row notes.

## 1. Everyone (any active membership)

| # | Workflow | Grade | Normative source | Notes |
|---|---|---|---|---|
| W-01 | Sign in / sign out / MFA challenge | D (form structure C via PUB-067/069) | 02 §7 | Never observed submitted at source, by policy |
| W-02 | Password reset; invitation activation | D | CAP-008/009 | Separated flows |
| W-03 | Switch active group | C | SPEC-01 | Declared+verified context; stale tabs rejected, never retargeted |
| W-04 | View my schedule (month/week/day) | C | CAP-020 | |
| W-05 | View organization schedule (3 views, filters, legends) | C | CAP-020 | Credit/assignment split visible |
| W-06 | Subscribe to calendar feed; rotate/revoke token | C (feature) / D (token lifecycle) | SPEC-09 | Divergence: no PII/token in URL |
| W-07 | View on-call board | C | CAP-044 | Telecom's only workflow |
| W-08 | Browse contacts directory | C | CAP-042 | PII minimised by role |
| W-09 | Download documents | C | CAP-048 | |
| W-10 | Manage profile, notification preferences, default group | C | CAP-007 | |
| W-11 | Review my notification delivery log; acknowledge critical notifications | D | SPEC-07 | No source equivalent exists |

## 2. Staff / locum members

| # | Workflow | Grade | Normative source | Notes |
|---|---|---|---|---|
| W-20 | Submit ON / OFF / No-Call request; view status history; withdraw | C (structure) / I (some transitions) | SPEC-08 | Request-Until-Date gate; `allowRequest` filter |
| W-21 | Submit shift preference | I | SPEC-08 | `accepted_as_input`, never "approved" |
| W-22 | Select vacation (quota/grant or open mode); view entitlement/variance; withdraw | C | SPEC-08 | Mon–Fri blocks |
| W-23 | Post an assignment to the opportunity board; retract | C | SPEC-13 | |
| W-24 | Claim an opportunity | I (accept path never fired) | SPEC-13 | Atomic version-bound claim; staff-over-locum window |
| W-25 | Propose a swap/transfer; accept/decline as counterpart | I (form observed, lifecycle unknown) | SPEC-13 | Ours is a design |
| W-26 | Take my picklist turn: view options, select, confirm | **D** — never observed | SPEC-02 | Timed; AT-completable (AX-5); I-13 confirm step |
| W-27 | Grant / accept / revoke a proxy; act as proxy on a turn | C (config) / D (execution) | SPEC-02 §4, PO-DEC-19 | Fully attributed |
| W-28 | Acknowledge an escalating notification | D | SPEC-07 | Durable acknowledgement halts ladder |

## 3. Scheduler

| # | Workflow | Grade | Normative source | Notes |
|---|---|---|---|---|
| W-40 | Author/edit shift types, shift groups, staff groups, valid groups | C | CAP-011/012 | Field-level inventory Confirmed (Phase 6) |
| W-41 | Maintain staff FTE / work profiles / max assignments | C | CAP-013 | Effective-dated |
| W-42 | Author pattern rules, staff rules, position restrictions; version a rule set | C (surfaces) / D (AST semantics) | SPEC-04 | Hard vs. weighted preference |
| W-43 | Configure and run a build; monitor 16-state lifecycle; read infeasibility explanation | **D** — no build ever run at source | SPEC-04; R21 | Explanations are bounded tiers, honest budget states |
| W-44 | Review candidate schedule: conflicts by severity, fairness variance, quality criteria | D | SPEC-04; PO-DEC-13 | Compare candidate builds (D-4 rescope) |
| W-45 | Manually assign/correct cells; move credit independently of assignment; pin assignments | C | CAP-019 | Per-cell provenance |
| W-46 | Publish a version; supersede; revert-forward; circulate partial schedule | D (source publish observed structurally; versioning ours) | SPEC-05 | Type-to-confirm friction; diff notification to affected staff |
| W-47 | Approve/deny requests, individually and in batch | C | SPEC-08 | Over-quota approval advisory + audited override |
| W-48 | Approve vacation, commit vacation to schedule, reverse a commit | C (commit) / D (reverse) | SPEC-08 | Reversal is forward revision |
| W-49 | Review/approve swaps and transfers (per group policy) | I | SPEC-13; PO-DEC-17 | |
| W-50 | Prepare picklist: import/create work items, order, lock, choose mode | C (surfaces) / D (import boundary) | SPEC-02/03 | Pick order derives from Master Schedule, not editable |
| W-51 | Run picklist: start/pause/resume/skip/complete; monitor live dashboard | **D** | SPEC-02 | Server clock; every intervention audited |
| W-52 | Correct a completed picklist | D | SPEC-02 §7 | Separate audited operation |
| W-53 | Generate/print/export/share reports; view statistics | C (2 of 6 dialogs) / D (rest) | SPEC-09 | Snapshot-bound artifacts |
| W-54 | Bulk-message staff | C (surface) | CAP-043 | |
| W-55 | Manage calendar events on the schedule | C | CAP-049 | |

## 4. Group / organization administrators

| # | Workflow | Grade | Normative source | Notes |
|---|---|---|---|---|
| W-60 | Invite users; assign membership roles and capability grants; suspend/reactivate/archive | C (roster surfaces) / D (grant model) | SPEC-06 | No untested flags |
| W-61 | Configure group settings (request-until date, picklist access, timezone, holidays, vacation mode) | C | R19 | Incl. the three fields report 17 discovered |
| W-62 | Manage entitlements; enable/disable modules | D | SPEC-06; PO-DEC-04 | Disable never deletes |
| W-63 | Upload/manage documents; set retention | C (structure) | CAP-048 | |
| W-64 | Impersonate a user (audited, banner, time-limited) | C (exists) / D (safeguards) | PO-DEC-11 | Source showed no audit trail |
| W-65 | Change a user's login email | D | CAR-027 | Sessions invalidated |
| W-66 | Manage connectors and the ingestion vocabulary; review quarantine (paths/codes/counts only) | D | SPEC-03 | Fast vocabulary-add path (RISK-30) |
| W-67 | Query the audit log; export audit evidence | D | SPEC-11 | |

## 5. Coverage note

Every WF-01..23 and LC-01..05 from the research maps into a row above (the mapping is 1:n where the source conflated flows). The workflows graded **D** are concentrated exactly where the research said they would be — picklist execution, build execution, delivery behaviour, auth flows — and each is covered by named SBX tests before its milestone exits ([15-testing-strategy.md](15-testing-strategy.md)).
