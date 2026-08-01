# 03 — Contradictions and Gaps

**Consolidated register: every known contradiction, every remaining evidence gap, every plan gap, with current status and ownership.** Sources: reports 11/16/17/20, the coverage audit, the Codex review + remediation, and my own audit ([01](01-existing-materials-audit.md) §4).

---

## 1. The twelve contradictions (C-01..C-12)

Report 20 is the authority; this table records my independent position. Key principle preserved throughout: **resolving SchedulePoint's design never asserts the source fact.**

| ID | Contradiction | Source-fact status | SchedulePoint resolution | My position |
|---|---|---|---|---|
| C-01 | Terminology inconsistencies (Group/Shift/Pick overloads) | Confirmed inconsistent | Glossary TERM-001..075 normalizes | Ratify |
| **C-02** | Picklist admin: Access Level gates admin surface, `Picklist Admin` flag appears vestigial | **UNRESOLVED, permanently** | **APPROVED (PO-DEC-02):** role + granular grants, every grant capability-tested, no vestigial flag | Ratify — SPEC-06 truth table implements it |
| C-03 | One request entity vs. two surfaces | Unresolved | One aggregate + constrained subtypes + linked vacation lifecycle (PO-DEC-03 **pending**, provisional in ADR-0016/SPEC-08) | Adopt working default; decision remains yours ([19](19-decisions-needed.md)) |
| **C-04** | Real-time vs. polling for picklist | **UNRESOLVED, permanently** (hub confirmed, payloads never seen) | **APPROVED (PO-DEC-18):** server-authoritative push, version tokens, resync, page-scoped | Ratify |
| C-05 | Instant-commit Add contradicts every other control's draft pattern | Confirmed (the safety incident) | I-13: no Add/New/Create persists before explicit Save | Ratify |
| C-06 | Directory vs. user roster ~30–35% membership gap | Unresolved rule | Explicit account types + explicit directory rules (PO-DEC-20 pending) | Adopt working default |
| C-07 | Minor cross-report count/naming conflicts | Resolved by stable-ID merge | — | Closed |
| C-08 | Public marketing centres automated scheduling; research sequencing under-weighted it | Resolved by AMD-17/report 19 | Automated scheduling `REQUIRED FOR PRODUCTION` (I-05); manual = fallback/override | Ratify — roadmap reflects it (solver is M4, not post-MVP) |
| C-09 | Public de-identification claim vs. observed clinical detail | **Unproven in both directions, permanently** | SchedulePoint boundary fully specified regardless (SPEC-03, I-07, I-17) | Ratify — the only stance that needs no source fact |
| C-10 | Push notifications claimed publicly, absent in product | Unresolved | Push is a first-class channel (PO-DEC-07 pending; SPEC-07 §3 design ready) | Adopt working default |
| C-11 | Group email address claimed, absent | Unresolved | Outbound-first vendor-domain identity (PO-DEC-21 pending) | Adopt working default |
| C-12 | Edition/pricing model absent in product | Unresolved | First-class entitlements (PO-DEC-04 **APPROVED**, technical only; commercial packaging pending) | Ratify technical; packaging is yours |

**No contradiction is "needs more research."** Each is either permanently unresolvable at the source (and safe to leave so) or resolved by a SchedulePoint design decision.

## 2. Remaining evidence gaps against the source (14, closed set)

All fourteen from report 16 §18, unchanged — no new source research can or should close them ([04](04-research-decision.md)). Each is mapped to the SchedulePoint test that replaces it:

| # | Gap | Replaced by |
|---|---|---|
| 1 | **Live picklist execution** (largest gap) | SPEC-02 design + SBX-020..027, SBX-033 in LIVE-SIM |
| 2 | Real-time concurrency (multi-tab, loss, races) | SBX-022/023 + SPEC-02 P-01..P-15 |
| 3 | Non-Scheduler role views | SBX-001/002 role fixtures + SPEC-06 cross-product |
| 4 | Form validation/error presentation | SchedulePoint's own design system + QA-A11Y-004/005 |
| 5 | Report dialog internals (4 of 6 types) | SPEC-09 + SBX-031a |
| 6 | Build execution/failure states | 16-state build lifecycle (report 21) + SBX-015..017 |
| 7 | Notification delivery behaviour | SPEC-07 (the source had no delivery log at all) |
| 8 | Session/idle timeout | Own design (02 §7) + QA-AUTH-001/002 |
| 9 | SignalR payloads | Own protocol (SPEC-02 event log) |
| 10 | Duplicate-request root cause | Irrelevant to us; SP-HR-2 budget tests |
| 11 | "OFF {X}" creation surface | Own request UI (CAP-021) + QA-REQ tests |
| 12 | Zoom/reflow | SPEC-14 AC matrix + SBX-034 |
| 13 | Contacts filter rule | PO-DEC-20 explicit rule |
| 14 | Two unopened PDFs | No requirement derives; stays closed |

## 3. Plan gaps (my audit, F-01..F-11)

See [01](01-existing-materials-audit.md) §4 for full detail. Status snapshot:

| Finding | Status |
|---|---|
| F-01 no roadmap · F-02 no delegation protocol | **Closed by this package** (deliverables 16, 17) |
| F-03 re-review not commissioned · F-09 CAR-026 authorization | **Awaiting your action** ([19](19-decisions-needed.md) D-B, D-C) |
| F-04 TDG spikes unsequenced · F-07 no UX brief · F-10 benchmark corpus | **Sequenced into M0–M2** ([16](16-implementation-roadmap.md)) |
| F-05 stale checkout-context sentence in doc 02 | **Open** — correct in next architecture edit; tracked NR-3 |
| F-06 playbook deferral contradiction | **Neutralized** — roadmap rule R-2 supersedes |
| F-08 OI/EV unowned · F-11 IR plan/runbooks/processor register | **Assigned owners + latest-need-by milestones** ([19](19-decisions-needed.md) §3) |

## 4. Open questions register (source: unresolved-questions.md, 94 entries)

The 94 source-site questions are **permanently closed as research items**; the 19 that matter are carried as named QA/SBX tests (mapping recorded in unresolved-questions.md tail note and report 11 §16). Ongoing project questions now live in [control/OPEN-QUESTIONS.md](control/OPEN-QUESTIONS.md), which starts from the decision register rather than the source-site list.
