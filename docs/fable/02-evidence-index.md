# 02 — Evidence Index

**Purpose:** one place that says, for every class of claim in this project, where the evidence lives, how strong it is, and whether it was independently re-verified. This index does not restate evidence; it locates and grades it.

**Evidence categories (per mandate):**
- **Confirmed** — directly observed (interface behaviour, read-only inspection, sanitized network observation, or a source document with clear evidence).
- **Strongly inferred** — supported by multiple observations, not directly verified.
- **Unknown** — insufficient evidence. Never silently promoted.

These map onto the corpus's own labels: OBSERVED → Confirmed; INFERRED → Strongly inferred; UNRESOLVED → Unknown. The corpus enforced this discipline end-to-end; I sampled for silent promotions and found none.

---

## 1. Primary evidence sources

| ID | Source | Kind | Covers | Reliability | Re-verified this audit? |
|---|---|---|---|---|---|
| E-01 | reports/01–11 + screenshots/ | Read-only observation of a live production tenant (Scheduler role, two groups) | 34 screens, 23 workflows, engine config surface, picklist surfaces, a11y/responsive, sanitized network | **High for OBSERVED**; role capabilities for non-Scheduler roles are INFERRED throughout (§3) | Sampled (V-read of representative reports) |
| E-02 | reports/17 (public sources) | ischedule.md homepage, pricing PDF, public login/reset pages, dated 2026-07-30 | 70 public claims PUB-001..070 | High as *claims about marketing statements*; a public claim is never evidence of behaviour | Cross-checked against report 19's PUB mappings |
| E-03 | final-coverage-audit.md | Passive DOM/href reconciliation across both groups | Navigation completeness; 7 new surfaces | High | Read |
| E-04 | reports/12–15 | Derived consolidation (no new navigation) | Glossary, features, entities, lifecycles | High as synthesis; inherits underlying labels | Sampled |
| E-05 | reports/19–24 | Authoritative derived layer | Scope, contradictions, engine requirements, traceability, evidence plan, gates | **High — the governing layer** | Read (19 extracted in full structure, 20/24 via register summaries + manifest) |
| E-06 | docs/architecture/references/official-technical-sources.md | Primary vendor documentation (PostgreSQL SET/RLS, OR-Tools languages/CP-SAT, Web Push) | Facts S-01..S-05 | High — verified against primary sources during remediation | S-03b/S-04/S-05 consequences spot-checked in SPECs |
| E-07 | docs/reviews/architecture/codex-architecture-review.md | Independent adversarial review | 27 defects in checkpoint `55bb7d8` | High | Read (findings section) |
| E-08 | Both validators | Executable checks | Structure + 15 semantic properties | High within their stated limits ("validates documentation, not software") | **Executed: research PASS; architecture 90/90 PASS** |
| E-09 | Git history | Provenance | One checkpoint per phase; review and remediation as separate commits | High | Inspected |
| E-10 | SchedulePoint_Claude_Workflow_Playbook.pdf | Process intent | 24-phase operating model | Context only — not product evidence; two known staleness issues ([01](01-existing-materials-audit.md) §3) | Read in full |

## 2. Evidence status of the major claim classes

| Claim class | Category | Where | Notes |
|---|---|---|---|
| Navigation surface, screens, admin config fields | **Confirmed** | E-01, E-03 | Coverage audit passed; both groups |
| Role = per-membership, not per-account | **Confirmed** | E-01 (multi-person corroboration) | The most important structural finding |
| Scheduler-role capabilities | **Confirmed** | E-01 | Only role ever held |
| Staff/Locum/View/Telecom/Genius capabilities | **Strongly inferred** | E-01 (flags, UI copy, cross-group) | No non-Scheduler session ever existed |
| Vacation lifecycle, requests, opportunities (structure) | **Confirmed** | E-01 | Forms/dialogs inspected; never submitted |
| Swap lifecycle, build execution, form validation/errors | **Unknown** | — | Requires mutations; carried as SBX tests |
| **Live picklist execution** | **Unknown** | — | Never observed. SchedulePoint's design (SPEC-02) is **our own**, tested by SBX-020..027/033 |
| Real-time hub existence (SignalR `picklist`) | **Confirmed** | E-01 Phase 11 | Hub confirmed; message payloads Unknown |
| Source defects (identifier leak, request amplification, instant-commit Add, delete-on-inspect, broken widget, a11y failures) | **Confirmed** | E-01 | Each individually evidenced; drive SP-HR-1..6 |
| Scheduling engine internals / algorithm | **Unknown, permanently** | — | Clean-room: report 21 + SPEC-04 define SchedulePoint's own model |
| Public speed claim (~2,700 cells in seconds) | Public claim only | E-02 PUB-049 | Explicitly not a SchedulePoint guarantee |
| PostgreSQL `SET LOCAL` semantics, OR-Tools language support, Web Push subscription fields | **Confirmed (primary docs)** | E-06 | The three facts that reshaped the architecture |
| Remediation design changes exist as claimed | **Confirmed for sampled findings** (CAR-001/002/003 vs. SPEC-01/02); **Strongly inferred for the rest** (validator checks 40–54 + consistent cross-references) | E-08, V-spot | Full verification = the pending independent re-review |
| Any capability *works* | **Unknown** | — | Nothing is implemented; no test executed |

## 3. Standing rules I adopt for all future evidence

1. **Additions only through named artifacts.** New evidence (spike results, SBX executions, benchmark runs) enters via files under `docs/evidence/` with a stable ID, date, environment, and command record — the SPEC-16 nine-field contract applies to all of it, not just SBX tests.
2. **No promotion without a named artifact.** "The spike passed" requires the harness output committed; a claim in a summary document is not evidence (this is the lesson of the review's "the validator proves shape, not truth" critique, applied forward).
3. **Source-site evidence is closed.** Every remaining Unknown against ischedule.md stays Unknown permanently unless a separately-authorized comparison need arises ([04-research-decision.md](04-research-decision.md)).
4. **Sub-agent reports are claims, not evidence,** until their commands/tests are re-run or their diffs reviewed per [17-opus-agent-runbook.md](17-opus-agent-runbook.md) §6.
