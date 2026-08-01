# 01 — Existing Materials Audit

**Independent audit of every existing artifact.** Nothing was assumed correct because Claude Opus produced it; the Codex review, the validators, and my own spot-checks were used as cross-evidence. Verification method key: **V-run** = validator executed by me this session; **V-spot** = content spot-checked against a claim; **V-read** = read in full or in representative depth; **V-index** = assessed via manifest/index plus targeted extraction.

---

## 1. Research corpus (`schedulepoint-research/`)

Both validators pass as of this audit: `validate.sh` (required files present, non-empty) and the manifest parses. Git history shows one checkpoint per phase — provenance is reconstructible.

| File | Purpose / scope | Completeness | Reliability | Staleness / contradictions | Authoritative? | Independent verification required? |
|---|---|---|---|---|---|---|
| RESEARCH-RULES.md | Read-only navigation policy | Complete | High — policy doc, self-enforcing via prompts | Current | Yes, for any future source contact | No |
| MASTER-CHECKLIST.md | Phase tracking | Complete through Phase 14 | High | Ends before implementation phases | Superseded for planning by this package | No |
| reports/01–11 (phase reports) | Screens, roles, workflows, master schedule, engine config, requests/vacation, picklist, supporting modules, responsive/a11y, technical, QA catalogue | Complete per phase; merge-by-stable-ID discipline held | **High for OBSERVED claims; appropriately labelled elsewhere.** One safety incident (Phase 8) documented, not hidden | Phase 1 role model superseded by Phase 2 (recorded); scope sections of several superseded by report 19 (recorded) | Yes, as evidence | No — sampling confirmed label discipline |
| reports/12–15 (glossary, features, domain, state machines) | Consolidation: 75 terms, 46 features, 44 entities, 21 lifecycles | Complete | High; contradictions preserved rather than resolved; 11/21 STMs honestly Low-confidence | Feature dispositions superseded by report 19 (recorded in-file) | Yes, beneath report 19 | No |
| reports/16 (research completion) | Handoff | Complete | High | §§13–15 superseded by AMD-17 — **amendment is recorded in-file**; safe | Yes, as handoff record | No |
| reports/17 (public-source addendum) | 70 public claims, 19 gaps, C-08..C-12 | Complete | High — sources and dates recorded | Current | Yes | No |
| reports/18 (sandbox test plan) | 39 SBX tests, 7 environments, 10 accounts | Complete | High, **except closing prose says "36 tests" — 39 exist (CAR-026)** | Count error only; detected by validator check 53 | Yes | **Correction requires your authorization** (CAR-026) |
| **reports/19 (production capability baseline)** | **58 capabilities; the scope authority** | Complete; every capability carries full field set | High; dispositions coherent; milestone assignments usable | Current | **YES — governs scope over all earlier reports** | No |
| reports/20 (contradiction register) | C-01..C-12 resolutions | Complete; 4 decisions APPROVED 2026-07-31 recorded | High; source-fact vs. SchedulePoint-design separation maintained | Current | Yes | No |
| reports/21 (scheduling requirements) | Clean-room engine spec | Complete | High; evidence-status labels on every element; public speed claim correctly not adopted | Current | Yes | No |
| reports/22 (traceability matrix) | Programmatically derived 58-row map | Complete; machine-checkable | High | Current | Yes | No |
| reports/23 (evidence plan) | 8 environments, assumptions register | Complete; architecture recorded unblocked 2026-07-31 | High | Current | Yes | No |
| reports/24 (production gates) | 30 gates, 14-item readiness bar, decision package | Complete; PO-DEC-10 row restored 2026-08-01 | High | Current | **YES — the gate authority** | No |
| evidence-register / source-page-index / unresolved-questions (94 questions) | Indexes | Maintained | High | unresolved-questions correctly marks remaining items "open permanently" | Yes | No |
| screenshots/ (7 dirs) | Sanitized visual evidence | Present | Not individually re-audited; naming convention enforces sanitization | — | Supporting evidence | Sample-audit before any external sharing |

**Research verdict: RETAIN, authoritative.** The precedence chain (19 governs scope → 20 governs contradictions → 24 governs gates → earlier reports as evidence) is explicit and consistently recorded where superseded. This is the strongest property of the corpus: no silent supersession was found.

## 2. Architecture package (`docs/architecture/`)

`validate.py`: **90/90 assertions pass** (V-run). Checks 40–54 verify semantic properties (referenced structures resolve, invariants unique, pending decisions not implemented as approved, no infrastructure artifacts exist) — materially stronger than shape-checking, though still documentation-level proof only.

| Artifact | Assessment | Authoritative? |
|---|---|---|
| 01 overview (22 invariants I-01..I-22) | V-read. Coherent; invariant collision (old I-05) fixed; extraction boundaries sensible | Yes, as PROPOSED |
| 02 technology stack | V-read. Honest about decided (PostgreSQL, CP-SAT/Python, WebSocket, Node/TS) vs. gated (TDG-01..15). §3.2's "context on every connection checkout" sentence is a **stale remnant contradicting SPEC-01 §4** — see finding F-05 below | Yes, with F-05 correction |
| 03–07, 09, 11–13, 15–18 | V-index + targeted reads. Revised consistently with remediation claims where sampled | Yes, as PROPOSED |
| 08 scheduling engine + SPEC-04 | V-index. Typed rule AST, honest explanation tiers, layered cancellation — matches report 21 | Yes, as PROPOSED |
| 10 picklist + SPEC-02 | **V-spot.** D-3a/b/c, fencing tokens, gapless event sequence, idempotent commands all present in SPEC-02 as the remediation claims | Yes, as PROPOSED |
| 14 security (T-01..T-38) | V-index. Threat coverage broadened by CAR-015; §11 compliance non-claims intact | Yes, as PROPOSED |
| SPEC-01 | **V-spot.** Context tuple, `SET LOCAL` unit-of-work, fail-closed outside wrapper, five DB roles, T-01..T-15 — present in substance | Yes, as PROPOSED |
| SPEC-03..16 | V-index via remediation cross-references + validator checks 43–51 | Yes, as PROPOSED |
| 23 ADRs | All `PROPOSED`, correctly none accepted | Yes, as PROPOSED |
| drafts/CLAUDE.md, drafts/AGENTS.md | Extended by CAR-023 with 13 non-bypass rules; **not installed, not adversarially linted** | **No — drafts.** Superseded for delegation purposes by [17-opus-agent-runbook.md](17-opus-agent-runbook.md), which incorporates them |
| diagrams/, references/, manifest, validate.py | Consistent; references verified against primary sources per remediation (S-03b, S-04, S-05) | Yes |

**Architecture verdict: RETAIN as the working proposal, contingent on independent re-review.** The remediation record's per-finding claims matched the actual files in every spot-check I made. I did not re-verify all 27 findings line-by-line — that is precisely the re-review's job, and I have kept it blocking rather than duplicated it superficially.

## 3. Review artifacts

| Artifact | Assessment |
|---|---|
| docs/reviews/architecture/codex-architecture-review.md | Genuine, specific, high-quality review. Findings carry realistic failure scenarios and named regression tests. Unmodified since delivery (validator check 54d). **RETAIN as the review of record for checkpoint `55bb7d8`** — note it reviewed the *pre-remediation* architecture; it is not evidence about the current one |
| remediation/codex-review-remediation.md | Disciplined: does not self-approve, keeps CAR-026 open for the right reason, names residual risks the redesign itself introduced (RISK-27..31). RETAIN |
| SchedulePoint_Claude_Workflow_Playbook.pdf | The 24-phase operating model. Useful as process context. **Two corrections:** (1) its Phase 18 prompt says to "explicitly defer … documents, and full picklist automation" — written before report 19 established that these are `REQUIRED FOR PRODUCTION`; sequencing may defer them, production scope may not; (2) its model guidance predates this engagement — Fable orchestrates, Opus implements, per your mandate. Treat the playbook as historical process record, not a live instruction source |

## 4. Findings from the plan audit (Stage 2)

Severity: **C**ritical / **H**igh / **M**edium / **L**ow. "Plan" = the corpus read as a development plan.

| # | Sev | Finding | Evidence | Consequence | Response |
|---|---|---|---|---|---|
| F-01 | **C** | **No implementation roadmap, backlog, or milestone definitions exist anywhere.** Report 19 assigns capabilities to foundation/alpha/beta/production but nothing decomposes, sequences, or gates the work | Repo tree; playbook Phase 18 unexecuted | Implementation would begin unsequenced; the schema-stage proof obligations the remediation created would be discovered late or skipped | Created [16-implementation-roadmap.md](16-implementation-roadmap.md) |
| F-02 | **C** | **No sub-agent execution protocol.** drafts/AGENTS.md is explicitly "not installed"; nothing defines task packets, review evidence, or acceptance | drafts/ README note; validator check 39 | Implementation quality depends entirely on ad-hoc prompting; the review discipline that caught 27 architecture defects would not exist at code level | Created [17-opus-agent-runbook.md](17-opus-agent-runbook.md) |
| F-03 | **H** | **Independent re-review not commissioned.** Architecture is remediated-unverified; 25 findings carry "AWAITING INDEPENDENT VERIFICATION" | Remediation §5 | Schema and SPEC-level defects would propagate into migrations | Blocking condition for M1+; commission now, run parallel to M0 ([19](19-decisions-needed.md) D-B) |
| F-04 | **H** | **All 15 TDGs open, no spike run, and no plan sequences them.** TDG-02/03 are correctness-critical (data layer must honour `SET LOCAL`; statement pooling prohibited) | SPEC-15; 02 §1 | A wrong data-layer/pooler choice invalidates the tenant-isolation design after code exists | M0 closes TDG-01..04 by spike; remaining TDGs closed before first dependent milestone ([16](16-implementation-roadmap.md) §3) |
| F-05 | **M** | **Doc 02 §3.2 still says the RLS variable "must be set on every connection checkout"** — the exact mechanism CAR-002 withdrew; SPEC-01 §4 supersedes it but the stale sentence invites re-implementation of the defect | 02 §3.2 vs. SPEC-01 §4 | An implementer following doc 02 alone rebuilds the Critical defect | Correct doc 02 in the next architecture edit window (needs no approval — it implements the already-remediated CAR-002); recorded in [18-risk-register.md](18-risk-register.md) NR-3 |
| F-06 | **M** | **Playbook Phase 18 deferral list contradicts report 19 dispositions** (defers documents, vacation bidding, full picklist automation "unless approved") | Playbook p.20; report 19 §1 | If followed as written, production scope silently shrinks — the exact error AMD-17 corrected once already | Roadmap covers the complete baseline; deferrals are sequencing-only and disclosed ([16](16-implementation-roadmap.md) §1 rule R-2) |
| F-07 | **M** | **No UX brief or design-system decision exists**, while SPEC-14 requires a component × property acceptance matrix and TDG-14 disqualifies libraries that fight accessible defaults | SPEC-14; playbook Phase 19 unexecuted | UI slices in M2+ would each invent their own patterns; a11y acceptance would be retrofitted | Roadmap M0 includes the design-system spike + UX brief as a deliverable gate for M2 |
| F-08 | **M** | **OI-1..7 and EV-1..8 have no owner or deadline** (RPO/RTO, provider, region, residency, vendor specs, provider sandboxes, benchmark bands, AT lab) | SPEC-10; SPEC-16; remediation CAR-025 | Specific gates (G-BETA a11y evidence, G-PROD restore rehearsal, G-CONN) will block late and surprise | Assigned to decision register with latest-need-by milestones ([19](19-decisions-needed.md) §3) |
| F-09 | **L** | **Report 18 count error (CAR-026)** — correction authorized-pending | Validator check 53 | Reader confusion only; mitigated by validator | Authorization request in [19](19-decisions-needed.md) D-C |
| F-10 | **L** | **Solver benchmark corpus (B-*) named but unbuilt; acceptance bands undefined** — acceptable now, must exist before CAP-015 exit | SPEC-04; remediation CAR-006 | Solver "works" would be unfalsifiable at M4 | Corpus construction is an M2 deliverable (it needs the rule model, not the solver) |
| F-11 | **L** | **Incident response, runbooks, processor register, breach-notification determination all absent** — already named in corpus | 14 §10; RISK-15, RISK-24; CAR-019 | Production gate items | Owned in roadmap M12 + decision register |

**No finding requires reopening an approved decision (PO-DEC-00/02/04/08/18), and none contradicts the capability baseline.** The corpus survives independent audit; the plan layer did not exist to audit.
