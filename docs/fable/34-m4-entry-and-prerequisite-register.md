# 34 — Milestone M4 entry record and prerequisite register

**Dated 2026-08-07. M4 authorized by the product owner against the frozen M3 checkpoint `7b579f2809f3007621580524a04ed111d8a05fe7` (tag `milestone/M3`).** This document is the dated M4 entry record the authorization requires, the register of automated-scheduling functional prerequisites (the M4-000 scope), and the record of the pre-M4 checkpoint verification. Finalized task packets live in [35-m4-task-packets.md](35-m4-task-packets.md); the exit report will be document 36 (`36-m4-exit-report.md`, created at milestone close).

---

## 1. Standing statements required by the authorization

1. **M3R is PAUSED by product-owner direction.** M3R is not completed, not cancelled, not superseded, and not absorbed into M4. Its outstanding findings remain in the project register and retain their existing production gates. Nothing in M4 changes M3R's status; only the product owner can.
2. **M4 is authorized to implement SchedulePoint's automated-scheduling capability** (the I-05 production mechanism; CAP-015/016/017/018/059 and the M4 rows of the parity matrix) **and the functional prerequisites that the automated-scheduling pipeline directly depends on** (§4 below — the M4-000 register).
3. **M4 does not resolve M3R findings that are unrelated to the solver pipeline.** Where an M4-000 prerequisite coincides with an M3R finding because the solver directly consumes the affected surface, M4 may close that functional prerequisite; the closure is evidence for that finding but is recorded as M4 work, not as M3R progress, and M3R's own register and gates are untouched.
4. **No production-readiness claim follows from beginning or completing M4.** The `milestone/M4` tag, if reached, means the M4 functional milestone passed its documented evidence — nothing more. It does not mean M3R is complete, and it does not mean SchedulePoint is ready for beta or production. The external architecture re-review still blocks beta entry (V-04); G-BETA and G-PROD remain open; no compliance claim of any kind is made.
5. **Not begun in M4** (explicitly out of scope, per the authorization): requests, vacation, notification delivery, marketplace, picklist, reports, documents, external connectors, and all M5+ functionality. Rule kinds whose required input belongs to a later milestone remain explicitly gated with a named owner (§4-D).
6. **Manual scheduling remains an override, recovery, and fixed-input mechanism.** It is not an acceptable substitute for automated scheduling in production (I-05, non-bypass rule 7).
7. The clean-room boundary is unchanged: research is closed; the source product is not visited or interacted with; synthetic data only; no real notification is sent.

## 2. Pre-M4 checkpoint verification (2026-08-07, exit codes checked directly)

| Condition | Result |
|---|---|
| `git rev-parse HEAD` | **`7b579f2809f3007621580524a04ed111d8a05fe7`** — CONFIRMED |
| `git rev-parse milestone/M3` | **`7b579f2809f3007621580524a04ed111d8a05fe7`** — CONFIRMED (identical) |
| Working tree | **clean** (`git status --porcelain` empty) |
| `python3 docs/architecture/validate.py` | **95/95 PASS, exit 0** |
| `python3 docs/fable/validate.py` | **36/36 PASS, exit 0** |
| `bash schedulepoint-research/validate.sh` | **PASS, exit 0** |
| `corepack pnpm check` | **13/13 gates PASS, exit 0** (lint · typecheck · unit [1384 tests/109 files] · import-boundary · route-policy · migration-rls · invariant-ids · rule-node-mapping · secret-scan · build · network-guard · axe · request-budget) |
| `corepack pnpm red-cases` — first run | **18/21 proven, exit 1** — `axe`, `i13-schedule-authoring`, `publish-idempotency-key-retained` NOT PROVEN on their GREEN arms. Diagnosed, not dismissed: a Playwright child process from the immediately preceding `pnpm check` axe gate wedged (40+ minutes, killed at 13:49) and held the derived preview port; the three failures are exactly the preview-port cases running inside that window, and the RED arms of the same window are treated as unreliable too. The runbook's standing instruction for this signature — re-run serially before concluding anything — was applied |
| `corepack pnpm red-cases` — clean serial re-run, quiet machine | **21/21 PROVEN, exit 0.** This is the authoritative entry result; the first run is retained above because a discarded failure without a recorded diagnosis is how contention signatures get normalized |
| `corepack pnpm sbx` | **exit 0** — 6/6 scenarios PASS (001/002/004/005/006/018), all falsifiable, 0 vacuous, 0 probe errors; SBX-004 sweep 308 readings across 7 contexts, **44/44 tenant tables observed non-vacuously, 0 wrong-tenant rows**; 91/91 organization-scoped routes byte-identical foreign-vs-nonexistent; audit chains verify 0/N/0 |
| `corepack pnpm fixture-regression` | **102/102 PASS, exit 0** — 13 fixed seeds + rotating seed 417227 (965 tests each, file AND test order shuffled), full per-file standalone sweep, baseline-immutability control clean in every run |
| No unmatched shell globs used for validator discovery | CONFIRMED — validators invoked by exact path |
| Required reading | Completed: docs/fable 16 · 12 · 32 · 33; docs/architecture 08; SPEC-04 · SPEC-05 · SPEC-12; all 13 live control documents; M1–M3 evidence indexes; `EV-M3-INTEGRATION/step-06-node-kinds.md` (the 6/24 rule-kind table of record) |

## 3. Document numbering and orchestration

Next available document numbers are used as the authorization directs: **34** (this entry record and prerequisite register) · **35** (finalized M4 task packets) · **36** (M4 exit report). Orchestration is unchanged from M3: finalized packets before issuance · isolated worktrees with derived ports · pre-declared shared files and integration surfaces · a separate independent reviewer for every packet with reviewer-authored falsification tests · escalation rather than improvisation · serialized merges in dependency order · the complete applicable battery after every merge · additive migrations only · stable IDs preserved · no test, gate, data constraint, accessibility requirement, or scheduling invariant weakened · synthetic data only · no real notification · stop before M5.

The mandatory packet sequence is **M4-000 → M4-001 → M4-002 → M4-003 → M4-004 → M4-005**. Packets may be split further where that keeps review, rollback, or evidence clearer; they are never combined into fewer, larger packets. **M4-000 must complete before the real solver packet begins.**

## 4. The automated-scheduling prerequisite register (M4-000 scope)

Every entry below is a functional prerequisite the solver pipeline directly consumes. Current state was verified against the tree at `7b579f2` before authoring the packets. Entries marked ⚑ are places where the current implementation is known to fall short of the required behaviour; unmarked entries need verification and proof rather than repair.

### A. Weekday demand
Current state: `shift_type_weekday_demand` (catalogue defaults, PUT whole-set per shift type) and `schedule_requirements` (period instances, PUT whole-set per period). ⚑ Neither editor exposes an aggregate consistency mechanism (`expectedVersion`); concurrent replacements can interleave; the editors do not prove load-before-edit; a no-op save's audit posture must match FAD-24 (no-op writes unaudited, with a control). Required: true atomic whole-set replacement; one documented canonical rule for omitted entries; concurrency-controlled replacement that cannot produce an unintended union; open-then-save-unchanged never resets values; no-op not recorded as a change; I-10 preserved.

### B. Qualifications and work profiles
Current state: `qualifications.requires_expiry` is stored but ⚑ not enforced at the service or database boundary when a holding is written without an expiry; `status ∈ {active, retired}` exists but ⚑ retired behaviour for new holdings, existing holdings, and new shift-type requirements is undefined; holding/qualification mutations are not consistency-controlled; work-profile rows are forward-only authored but ⚑ have no correction/cancellation path for future-effective rows; the in-force reads exist (`in-force-loader.ts`) — solver input must use exactly the row in force at the build instant (the S-03 ruling carried from M3 §13.8). Required additionally: one shared eligibility verdict for manual scheduling, solver input, independent output validation, and publication; distinct functional outcomes for expired / future / revoked / retired / missing; shift-type qualification requirements enforced even without a duplicate authored rule.

### C. Group-scoped relationships
For every group-scoped reference used by scheduling — at minimum `qualification_holdings`, `staff_group_members`, `assignment_snapshots`, `credits`, `current_published_assignments`, and the future solver-created candidate assignments — prove at the database (composite FK or invariant check, never UI filtering alone) that the referenced record belongs to the same group. For membership references used by scheduling, define and enforce membership kind, active/inactive behaviour, effective dates, ended membership behaviour, and functional/placeholder participants.

### D. Rule versioning and registry
Current state: `rules.rule_schema_version` exists; ⚑ no `expectedVersion` on rule/rule-set mutation (last-write-wins); ⚑ no immutable/reconstructable rule revisions, so a build cannot yet identify the exact revisions used; the rule-kind registry is the AST source plus `step-06-node-kinds.md` (6 EVALUATED / 24 NOT-EVALUABLE, totality test-asserted). Required: expectedVersion on mutable rules/rule sets; revisions immutable or reconstructable; stable logical rule identity never silently changes historical meaning; builds and publications record exact rule revisions; the registry generated from the closed AST/code proving exactly 30 unique kinds with disjoint evaluated/unevaluated sets and per-kind classification, required input, semantic ruling, evaluation owner, and milestone owner where input arrives later; the known counting/classification discrepancies corrected; AST depth, list sizes, numeric ranges, scope cardinality, evaluation time and memory bounded.

### E. Schedule graph
Enforce consistency (composite relationships, invariant checks, or guarded transitions) across: period↔version; requirement↔period date range; shift↔version; shift↔period date range; assignment identity↔period; snapshot↔identity; snapshot↔shift; assignment participant↔group; credit↔identity; credit↔snapshot; credit↔version; publication↔period/version; supersession metadata; `current_published_assignments`↔the actual current published version.

### F. Locations and time
Current state: `locations` exists (M3-007) but ⚑ shifts have no location relationship; location is absent from contracts and authoring/build inputs; archived-location behaviour undefined; group timezone exists (`groups.timezone`), location timezone column exists but semantics vs group timezone undefined; ⚑ date validation is shape-only in places; DST gap/fold, overnight, UTC+14/−12, leap-year, and invalid-date behaviour must be explicit; the timezone interpretation needed to reproduce a build/published version must be snapshotted; timezone changes coordinated with build-input creation.

### G. Publication handoff
M4 candidates feed M3's publication model. Required before that handoff: complete period lifecycle (closed periods refuse new builds/publications without an explicit permitted transition); publication review identity expanded to every material schedule input (participant, date, time, shift type, location, pin, credit, conflicts, rule revisions, catalogue revisions, profiles, qualifications, demand, timezone); idempotency bound to operation type and semantic request; clone/revert-forward preserves credits; schedule differences and affected-participant calculations share one material-change definition covering time, shift type, location, pins, credits.

### H. Provider-outside-transaction control
Before any solver RPC exists: implement the documented rule (SPEC-12 U-07) that provider/RPC calls cannot occur inside a database unit of work — enforced statically (lint/gate) and at runtime; a red/mutation case proves the gate fails on a provider call inside a transaction; database snapshot creation and external solver execution stay separate, explicit phases.

### M4-000 exit conditions (verbatim from the authorization)
The real solver packet is not issued until: all M4-000 tests pass; relational consistency is database-proven; demand replacement is correct under concurrency; qualification/profile input selection is deterministic; the rule registry is generated and internally consistent; schedule-graph inconsistencies are refused; locations and timezone semantics are present in canonical input; provider-inside-transaction checks are active and falsifiable; the migration cycle passes; the full existing battery remains green.

## 5. Carried-item disposition into M4

From the M3 exit report §13, the items owned by M4 and therefore in scope now: rule-kind evaluation semantics (the 11 one-ruling-away kinds; rulings land in M4-002's semantics work) · the `AvoidDate` overnight-attribution ruling (owner question, resolved in M4-002 per the authorization) · in-force catalogue reads for solver inputs (S-03, M4-001). Items NOT pulled into M4: SPEC-14 M-cells (M6/EV-8) · settings-page consolidation (M6 family) · retroactive-history authoring (owner decision, M6 if approved) · request-until enforcement (M5) · picklist-access enforcement (M9) · CAP-020 three-view completion (M6). None of these is dropped; each keeps its recorded owner.
