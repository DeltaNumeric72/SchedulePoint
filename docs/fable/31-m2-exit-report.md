# 31 — Milestone M2 Exit Report

**Date:** 2026-08-04. **Authorization executed:** "Begin Milestone M2" against frozen checkpoint `b051193` (2026-08-03). **Orchestrator:** Fable. **Status: M2 tasks 4/4 ACCEPTED and merged. M3 NOT authorized — awaiting the owner.** The frozen M2 checkpoint is this report's commit, tagged `milestone/M2` (and `milestone/M1` retro-tagged at `b051193` — the tag required by [24](24-execution-standards.md) §E was missed at M1 close; disclosed, not hidden).

---

## 1. Task outcomes

| Task | Outcome | Merged as | Evidence |
|---|---|---|---|
| **OPUS-M2-001** SBX harness + G-ARCH tenancy subset + NR-13 decision + MULTI | **ACCEPTED** after a four-round cycle (REVISE → delta REVISE → APPROVE WITH FOLLOW-UPS → a rotating-seed defect fixed at acceptance). NR-13 measured then ratified as FAD-15 with a mandatory mid-task stop honored | `bc61ee7` | [EV-M2-NR13](../evidence/EV-M2-NR13/INDEX.md) · [EV-M2-SBX](../evidence/EV-M2-SBX/INDEX.md) |
| **OPUS-M2-002** shift-type catalogue, groups, valid combinations — **the product's first UI surface** | **ACCEPTED** after REVISE → delta APPROVE WITH FOLLOW-UPS → second-merger rebase (0004→0005) during which the shuffled gate exposed two microsecond-vs-millisecond window defects, fixed deterministically | `ff2e67b` | [EV-M2-CATALOGUE](../evidence/EV-M2-CATALOGUE/INDEX.md) |
| **OPUS-M2-003** effective-dated work profiles, FTE, qualifications (API-first) | **ACCEPTED** after APPROVE WITH FOLLOW-UPS (the in-force centerpiece survived every reviewer attack) + a final round closing T-01..T-08 | `567964c` | [EV-M2-PROFILES](../evidence/EV-M2-PROFILES/INDEX.md) |
| **OPUS-M2-004** integration + hardening (**prepared in advance per the authorization §5.6, issued after both parallel merges**) | **ACCEPTED** after APPROVE WITH FOLLOW-UPS (V-01..V-08 closed); one mid-task escalation ruled (request-budget recording globs + the budget=2 ruling) | `fce095c` | [EV-M2-INTEGRATION](../evidence/EV-M2-INTEGRATION/INDEX.md) |

**Why there was a fourth task.** Exactly as at M1: the parallel pair's disjoint scopes left composition surfaces unowned by construction — `shift_type_qualifications` joins both tasks' tables — plus the reviews accumulated cross-cutting defects (a production `sequence::text` sort, the shared-port hazard) that belonged to no packet. This time the integration packet was **pre-declared in the packet document (§5) before the parallel pair was issued**, and its scope accreted openly.

## 2. Commits, branches, worktrees, agents

- **Merges to main (chronological):** `73cd212` packets · `9888841` M2-001 issuance (+`29d90b7` validator-7b fix) · `fc6e3ca` FAD-15 · `1988435` runbook · `b9755d1` FAD-15 correction · `bc61ee7` M2-001 + `3e150a8` records · `20b9f7f` M2-002/003 issuance (+FAD-16) · `ff0a3b8` FAD-17 · `567964c` M2-003 + `e6623cd` records · `ff2e67b` M2-002 + `6eed886` records · `a0426ee` M2-004 packet · `ad6372e` deliverable-5 ruling · `fce095c` M2-004 + `90ae5c0` records · this report's commit (the frozen checkpoint).
- **Branches/worktrees:** `opus/m2-001-sbx-harness` · `opus/m2-002-catalogue` · `opus/m2-003-profiles` · `opus/m2-004-integration`, each in `.worktrees/`, squash-merged, removed after acceptance. Serialized merges held; the second merger (M2-002) rebased and renumbered its migration; no branch merged with a red gate.
- **Agents:** four implementers, three independent second reviewers (M2-001's reviewer ran three passes incl. two focused deltas; M2-002 and M2-003 had separate fresh reviewers, M2-002's running a delta pass; M2-004 a fourth fresh reviewer). Every acceptance decision preceded by the orchestrator re-running the battery.
- **Interruptions:** one mid-task tooling outage (M2-001's implementer lost Bash; stopped honestly with labelled unverified work) and one session limit killing both in-flight agents simultaneously. Both recovered per protocol: read-only worktree inspection, valid partial work preserved (M2-003's micro-round survived entirely in commits), nothing resumed from memory, and one unverifiable review pass restarted cleanly rather than trusted.

## 3. Independent-review findings and their resolution

Every task drew findings; two of four opened at REVISE. As at M1, **every blocking finding came from a reviewer writing its own probes**, and this milestone added a sharper pattern: the blockers clustered in the **evidence machinery itself** —

| Task | Verdict path | Blocking findings |
|---|---|---|
| 001 | REVISE → delta REVISE → APPROVE W/F | The vacuity detector recorded FALSIFIABLE on *any* probe throw (a TypeError, a SQL syntax error, and a never-executed sweep were all laundered into "falsifiable" on shipped scenarios); five declared evidence artifacts had never been written and nothing checked; then the fix's five-role sweep introduced a refusal **cascade** that recorded false causes in shipped evidence and hid six tables' readings; two probes observed an *absence* — the exact vacuity shape the task existed to kill — reproduced inside the detector built to kill it; the write arm never reached RLS while claiming to distinguish mechanisms |
| 002 | REVISE → delta APPROVE W/F | The cross-group arm of a named-condition proof was vacuous — the fixture never seeded a sibling group, and the reviewer's CAR-001-class policy mutation (group clause dropped, organization clause kept) left all six sweep tests green. Now pinned permanently as `sweep-mutation.test.ts` |
| 003 | APPROVE W/F | None blocking; mediums: reachable retroactive history creation contradicting a contract comment; the most common administrative call silently zeroing weekday targets |
| 004 | APPROVE W/F | None blocking; the one code finding: a blanket catch converting every read fault into 404 with a log line asserting a cause it never checked |

Beyond the blockers: an INSERT-blind capability gate; effective dating that was `created_at` in disguise; two tenant-unpinned functions, one an arbitrary-row read (the M1 S-01 class — which also **reappeared twice more**: once in M2-004's eligibility read, written by the agent that had just read the warning docblock, caught by M2-003's structural scan); a version counter that read as an optimistic-concurrency control and was not one; six false or overstated comments claiming controls that did not exist as described (the M1 false-comment class, now a standing reviewer probe); a production `ORDER BY` sorting a bigint as text, silently mis-aiming two security tests. All closed, each with regression evidence; reviewers re-ran their own original attacking probes to confirm.

**The rotating seed earned its ruling.** At M2-001's final acceptance, my own `fixture-regression` run drew seed 65339 and went red on a seventh coupled test in an M1-authored file. Per FAD-15 ruling 3 it was treated as a defect, fixed, and the seed joined the set. Across M2 the shuffled/rotating machinery caught real couplings **four separate times** — including twice in code written by the same task that built the machinery, and the implementers' own tally stands: of the couplings found in M2, roughly one was found by a human-style reading; the rest by shuffled execution or an adversarial reader.

## 4. What the orchestrator caught that the reviews did not

- The **"L3.3 kernel-guard mystery"**: M2-001's implementer escalated an undiagnosable refusal rather than improvising. Trigger-inventory diagnosis proved a `memberships` UPDATE *cannot* raise the observed error; the true source was the next row's superuser `capability_grants` INSERT — triggers fire for superusers even though RLS does not. No kernel defect; the control was working; the implementer's own earlier fix had already succeeded. The suspected-defect-that-wasn't is itself M1-kernel validation.
- The **rotating-seed coupling** at final acceptance (§3), present in both the implementer's and reviewer's green runs because neither had drawn that seed.
- A **premature "ISSUED" status** in the packet doc and a **masked validator failure** (piped exit code) during issuance — both mine, both disclosed in commit messages at the time, the second now guarded by exit-code-checked validator runs.

## 5. NR-13 — decision and evidence (the authorization's mandated outcome A)

**Measured comparison first, decision second.** Phase A measured per-test transactional rollback (S1), dedicated organizations (S2), per-file database clones (S3), and the hybrid (S4) against the real suite. **S1 was rejected as structurally impossible, not slow**: the kernel's own `NESTED_TENANT_CHANGE` guard makes cross-tenant probes inexpressible inside one transaction, and 20 of 24 files used a second backend the rollback could not cover — silent non-isolation as a failure mode. S2 alone missed 4 of the 6 measured couplings (non-tenant state). **S4 ratified as FAD-15** (mid-task stop honored; later corrected once from review evidence — the "RLS enforces ownership" claim was falsified and replaced with real controls: a per-run slug registry + nonce). Implemented: enforced-immutable baseline (digest names the offending file), per-file owned tenants via the MULTI factory, declared non-tenant preconditions, per-test subject ownership. **Regression gate:** twelve fixed seeds (each with provenance) + a rotating seed, both shuffle dimensions, all-files standalone sweep, Layer-1 control — a standing **acceptance-time** requirement (ruled: not per-commit; the gate runner was deliberately never modified). **NR-13 is retired** on the mechanism, not the extinction of the class: 63/63 on main at close, with the gate having caught the class four times during the milestone itself.

## 6. SBX harness and the G-ARCH tenancy subset (mandated outcome B)

| Scenario | State | Substance at close (on main, 26-table registry) |
|---|---|---|
| SBX-001 | **PASS**, falsifiable | Role × registered-surface matrix, 442 cells (13 principals × 34 surfaces), 0 unclassified; four outcome classes learned by executing (allow · clean deny · 409 context refusal · 422 body refusal reachable only after an allow); byte-identity checks per SPEC-01/FAD-11 |
| SBX-002 | **PASS**, falsifiable | The fifteen-row SPEC-06 truth table server-side (12 rows execute in 15 cases; L1.4/L6.1/L6.2 EVIDENCE_BLOCKED with named dependencies), each case behind an ALLOW control; the 49.0M-case domain cross-product cited as exhaustive companion with the sampling relationship stated; picklist arm re-executes at its milestone |
| SBX-004 | **PASS**, falsifiable | Cross-tenant sweep: five application roles × 7 contexts × 26 tables (182 readings), reads AND a 24-attempt write arm with per-cell mechanism labels, **0 wrong-tenant rows, all 26 tables observed non-vacuously**; both sanctioned cross-tenant exceptions (FAD-14 maintenance plane; `app_breakglass` per A-08) pinned positively by exact (role, table) pair; refusal whitelist (42501 only) makes cascade-vacuity impossible |
| SBX-005 | **PASS (partial by construction)** | Executable lifecycle arms run (membership status retention, suspension); authn-dependent arms **EVIDENCE_BLOCKED(authn milestone)** per SPEC-16 §7 — never a pass, never silent |
| SBX-006 | **EVIDENCE_BLOCKED(authn)** | Contract declared in full; no session subsystem exists |

Harness properties, all reviewer-attacked: nine SPEC-16 contract fields as a runnability precondition; `ProbeFalsified` sentinel vacuity detection (a probe must perturb, confirm ≥1 row touched, re-execute the shipped oracle, and witness rejection — any other throw is `PROBE_ERROR` and fails the run); per-scenario retained artifacts existence-checked against the run's own manifest; `EVIDENCE_BLOCKED` on a gate-required scenario exits non-zero. **G-ARCH is NOT closed** — by design it still needs SBX-011/013/014b/022/023/028 at their milestones. The M1 carried item (this subset) is discharged.

## 7. MULTI provisioning (mandated outcome C)

`provisionMulti(runner, {slug})` — a factory, per FAD-15's Layer 2. The canonical `full` profile: ≥2 organizations (plus Gamma, deliberately unentitled), ≥2 groups each, one user with different roles per membership, every SPEC-06 role, suspended/invited/ended membership cases. All ten mandated support points demonstrated; double-provision determinism proven modulo minted identity (canonicalization stated); ownership enforced by slug registry + per-run nonce (derivation attacks re-run and failing at M2-004 close); after M2-004's D-1 consolidation, `multi.ts` is again the **single fixture owner** with opt-in seeding.

## 8. Tenant and group isolation — findings

Zero wrong-tenant rows and zero successful cross-tenant writes in every probe by every agent across the milestone — implementers, three reviewers, and the harness (final: 182 readings, 26/26 tables non-vacuous). Group-boundary isolation proven in both directions on all nine catalogue tables and all five staffing tables, including the cross-group qualification requirement made **impossible at the database** by composite FKs carrying both tenant columns. The complete cross-tenant-exception census on main remains exactly two, both declared and pinned: the FAD-14 maintenance plane and `app_breakglass` (BYPASSRLS, SELECT-only, A-08) — the latter now disclosed to read SENSITIVE-PII cross-tenant by design, cross-referenced to the still-open SPEC-11 §3.2 break-glass-audit obligation.

## 9. Product functionality delivered

A scheduler or group administrator can now, through authorized, audited, tenant-isolated surfaces (UI for the catalogue; API for staffing):
- author **shift types** with the full observed concept set (FAD-16): names, description, CHECK-constrained display palette/typography tokens, times with overnight support, the four orthogonal flags, statistics visibility, LOA designation, report ordering, ON/OFF request eligibility, credit weight, authorable effective windows, archive-not-delete;
- bundle them into **shift groups** (scoring mode + weight, request-off semantics) and **staff groups**; constrain **valid combinations** against monotonic pick positions; author per-shift-type **weekday + holiday demand** and the **holiday calendar**;
- record **effective-dated work profiles** (FTE, weekday/holiday targets with carry-forward, max assignments) with deterministic in-force resolution, future-dating, forward-only authoring, and immutable history;
- grant **qualifications with expiry** (SENSITIVE-PII-narrowed reads) and bind them to shift types (**`shift_type_qualifications`**) with eligibility answerable per shift type and member.
The M4 engine's demand-side and people-side inputs now exist. Feature-parity movement: **8 rows verified, 2 in-progress** (CAP-001/002/003/006/011/012/013/058 · CAP-005/057), 48 not-started, none dropped.

## 10. Tests, validators, harnesses at close

**On main:** `corepack pnpm check` **12/12** · **881 tests / 66 files** (551 at entry) · `pnpm red-cases` **14/14** · `pnpm fixture-regression` **63/63** · `pnpm sbx` per §6 · migration cycle clean across all six migrations · six named-condition-proof families run standalone + in-package + in-battery with all three modes reported (and the all-files standalone sweep inside the gate re-proving every proof file standalone on main). Research validator PASS · architecture **95/95** · plan **36/36** (exit-code-checked). **Not run** (unchanged conditions): remote CI; container builds (FAD-7); external-pooler variant; solver under 3.12; SPEC-02/05/07/08/09/13 harnesses (subjects absent); the 33 non-tenancy SBX tests; T-03's remaining surfaces; screen-reader sessions for SPEC-14 `M` cells (every `M` cell **unclaimed**, honestly).

## 11. Architecture decisions confirmed or revised

**FAD-15** (NR-13 strategy; corrected once from review evidence) · **FAD-16** (catalogue field-set amendment to doc 06 §3.2) · **FAD-17** (weekday+holiday day domain; the schema-test narrowing with its non-vacuity conditions — the recursion hazard verified real-and-caught by construction) · mid-task rulings recorded in the packet doc: D-1 fixture interim → consolidation (executed), SBX-002's row-complete-server-side + exhaustive-at-evaluator standard, the budget=2 request-budget ruling (PO-DEC-18-grounded), the holiday-read population ruling. Doc 06 amended three times, all dated and additive. No ADR contradicted; none silently edited; architecture remains PROPOSED pending the external re-review (V-04, blocking beta).

## 12. Risks closed and opened

**Closed/retired:** NR-13 (§5) · E-1/E-2 port-collision hazard (derived ports, proven by simultaneous batteries). **Stays elevated:** NR-4 — richer M2 data in the register: blockers again reviewer-authored; self-review improving (three implementer self-catches, one self-corrected falsified premise) but demonstrably insufficient alone. **Opened:** NR-14 (regenerated evidence artifacts; low/low, standing-discipline-managed, redesign candidate at M3 entry). **Unchanged standing conditions:** external architecture re-review before beta (blocking, V-04); FAD-7 CI conditions; EV-1 vendor specs.

## 13. Carried items — all named, all owned

1. **SBX-005/006 authn arms + SPEC-11 X-12**: blocked on the authentication/session/invitation subsystem — a roadmap-M1 slice never packeted; **it is the first proposed M3 packet below.**
2. **Roadmap-M2 slices not in the authorized packets** (rule authoring/AST + compiler, B-\* benchmark corpus, remaining group settings incl. request-until/picklist access/timezone, site attribute per PO-DEC-01 default): carried; the rule engine is proposed for M3 given M4 depends on it.
3. **In-force catalogue reads** land at M4 (S-03 ruling); **retroactive history authoring** is a future administrative capability requiring its own decision (T-01 ruling); the eligibility read's absent-vs-empty answer (M2-004 INDEX limitation).
4. **Scheduler-vs-calendar-key edge** (grant-only calendar holder: write-not-read) — product question, recorded.
5. **SPEC-14 `M` cells** need the assistive-technology sessions (EV-8) before any support claim.
6. **Break-glass session auditing** (SPEC-11 §3.2) still unimplemented — M1 residual, restated.
7. **NR-14** artifact-regeneration hygiene, M3-entry redesign candidate.

## 14. Control-document audit

| Document | Updated | Summary |
|---|---|---|
| PROJECT-STATUS | **yes** | M2 complete; state at close; M3 boundary |
| OPUS-AGENT-RUNBOOK | **yes** | Four task rows with verdict paths; four standing notes (derived ports, red-case invocation, port wait, regenerated artifacts) |
| TEST-TRACEABILITY | **yes** | Three M2 execution rows + issuance rows updated with measured figures |
| EVIDENCE-INDEX | **yes** | EV-M2-NR13/SBX/CATALOGUE/PROFILES/INTEGRATION |
| ARCHITECTURE-DECISIONS | **yes** | FAD-15 (+correction), FAD-16, FAD-17 |
| RISK-REGISTER | **yes** | NR-13 retired, NR-4 re-evidenced, NR-14 opened, E-1/E-2 closed |
| FEATURE-PARITY-MATRIX (+ living doc 06 rows) | **yes** | 8 verified / 2 in-progress with dated evidence citations |
| IMPLEMENTATION-ROADMAP | **yes** | M2 COMPLETE with the honest scope note |
| CHANGELOG | **yes** | Four M2 entries |
| ASSUMPTIONS | no | FA-1..FA-6 unchanged by M2 (FA-3 already discharged at M1) |
| PRODUCT-DECISIONS | no | No product decision changed; PO-DEC-18/04 were applied, not altered; PO-DEC-01/03/12 defaults used as defaults |
| OPEN-QUESTIONS | no | Q-6/7/8 unchanged |
| ORCHESTRATION | no | Model unchanged and validated again by use (pre-declared integration packet worked as designed) |

## 15. M2 exit criteria — verdict

The owner's authorization defined M2 as the three packets plus any required integration, with mandated outcomes A (NR-13), B (SBX subset), C (MULTI). **All four tasks accepted; A, B, C delivered as specified — PASSED**, with outcome B's SBX-005/006 authn arms `EVIDENCE_BLOCKED` per SPEC-16 §7 (named, counted, never a pass) and G-ARCH deliberately still open pending its non-tenancy tests. The roadmap's fuller M2 ambition (rules, corpus) was **not** part of the authorized scope and is carried explicitly, not silently (§13.2). Working tree clean; this commit is the frozen checkpoint.

## 16. Recommendation and the proposed first three M3 packets

**M3 is recommended.** The platform now has proven tenancy, authorization, audit, an evidence harness that detects its own weaknesses, and the scheduling structure a schedule needs. The natural M3 (roadmap: manual schedule → immutable published version) needs authn for real users and rules for real builds; sequencing below reflects that plus the carried items.

- **OPUS-M3-001 — Authentication, sessions, invitation/activation (the carried M1 slice).** First-party email+password + MFA (TOTP), server-side sessions with idle+absolute lifetimes, invitation/activation separated from reset (STM-017/018), login-email change (CAR-027), session-epoch integration with the freshness counters. Exit: SPEC-11 X-12; **SBX-005/006 unblock and execute in full**; SBX-001's matrix re-runs with real sessions. Critical class.
- **OPUS-M3-002 — Rule model: typed AST, compiler, authoring (the carried M2 slice M4 depends on).** `rules`/`rule_sets` per doc 06 (CAR-006 CHECK discipline), closed node set (unmapped node fails CI), round-trip author → compile → re-validate, authoring UI on M2-002's foundation, B-\* corpus generator + first committed fixtures. Exit: round-trip proven; corpus committed (the roadmap's original M2 exit criterion, honestly relocated).
- **OPUS-M3-003 — Schedule periods + the identity/snapshot assignment model + publication (SPEC-05 core).** `schedule_periods`, `assignment_identities`/`assignment_snapshots`, `credits`, D-15 immutability triggers, D-16/D-17 idempotent single-current publication, V-01..V-16 harness, SBX-018. The spine's first half; the grid UI follows in a later M3 packet. Critical class.

Sequencing: M3-001 first (unblocks SBX-005/006 and real-session testing for everything after); M3-002 and M3-003 then in parallel (disjoint: rules vs schedule spine), integration packet pre-declared for the surfaces they share (build inputs touch both). All critical class; independent second review mandatory; the M2 evidence machinery (fixture-regression, sbx, ProbeFalsified discipline) is the standing floor.

**Exact authorization prompt to begin M3:**

> Begin Milestone M3. Issue OPUS-M3-001, then OPUS-M3-002 and OPUS-M3-003 per the M2 exit report, under the same rules as M2: finalized packets before issuance, isolated worktrees, full quality gate per 24-execution-standards including fixture-regression and the SBX battery at acceptance, independent second review for all three, standalone plus full verification of every named-condition proof, commit each accepted task separately, escalate rather than improvise, produce the M3 exit report, and stop before M4.

---

**Stopping here per the authorization. M3 begins only on your explicit instruction.**
