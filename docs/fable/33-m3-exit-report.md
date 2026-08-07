# 33 — Milestone M3 exit report

**M3 authorized 2026-08-04 against frozen M2 checkpoint `e476573` (tag `milestone/M2`); complete 2026-08-05. Eight tasks, all ACCEPTED and merged. This document's commit is the frozen M3 checkpoint, tagged `milestone/M3`. M4 is NOT begun.** Authoritative packet record: [32-m3-task-packets.md](32-m3-task-packets.md). Evidence: `docs/evidence/EV-M3-*` (eight bundles).

## 1. Task outcomes

| Task | Scope | Merge | Review verdict path |
|---|---|---|---|
| OPUS-M3-001 | Authentication, sessions, invitation/activation | `6a01196` | REVISE (2 blocking) → delta ACCEPT |
| OPUS-M3-002 | Typed rules, compiler, authoring, B-\* corpus | `7dd37dc` | REVISE (1 blocking) → delta ACCEPT; mandatory pre-migration escalation honored (FAD-21) |
| OPUS-M3-003 | Schedule periods, identity/snapshot model, publication core | `e275597` | REVISE (2 blocking) → delta ACCEPT (FAD-22) |
| OPUS-M3-007 | Group settings and site attribute | `c3e1baa` | **Zero blocking** → NB delta → ACCEPT (FAD-24) |
| OPUS-M3-004 | Scheduler authoring experience + 27 rule editors | `20c0c13` | REVISE (4 blocking) → delta ACCEPT (FAD-23) |
| OPUS-M3-005 | Publication and version-management experience | `112b8c4` | **Zero blocking** → mini-delta → ACCEPT (FAD-26) |
| OPUS-M3-006 | Staff-facing schedule views | `57685ab` | **Zero blocking** → claim-accuracy delta → ACCEPT (FAD-25) |
| OPUS-M3-008 | Integration and hardening | `dfa717f` | REVISE (2 blocking + orchestrator O-1) → delta ACCEPT (FAD-27) |

Sequencing as authorized: 001 alone → 002 ∥ 003 (serialized merge, second merger rebased with disclosed composition) → 004 ∥ 007 (wave 1) → 005 ∥ 006 (wave 2) → 008 alone. Every packet: isolated worktree, derived DB/preview ports, explicit allowed/prohibited paths, independent second review with reviewer-authored probes, orchestrator rerun of every acceptance command from a fresh checkout, squash-merge by Fable, complete validation after each merge.

## 2. Branches, worktrees, commits, reviewers

Branches `opus/m3-00X-<slug>` in `.worktrees/m3-00X`; every implementer and every reviewer was a separate Opus sub-agent; reviewers worked in detached `-adv` worktrees with their own clusters and never modified the branch. Close-out commits: `05aa30c` (authorization+packets) · `16e3e11` (001 issued) · `0db42d4` (001 close-out) · `18237aa` (FAD-21) · `585c8a2` (FAD-22) · `a616cec` (002/003 close-out) · `d8babbe` (004..008 finalized) · `d12d469` (wave-1 close-out) · `caec1d9` (wave-2 close-out) · this commit (exit).

## 3. Independent-review findings and remediation

Every blocking finding of the milestone, each closed with a red-cased or falsification-proven fix and a delta re-verified by the orchestrator on a fresh checkout:

- **M3-001:** a raw session secret printed into two committed evidence files (the secrecy scan excluded the files it generates — now scans them, with a planted-secret probe); SBX-001 not actually re-driven through real sessions with a stale-false `EVIDENCE_BLOCKED(authn)` (orchestrator-found; the 611-cell matrix now runs on 10 real per-role sessions).
- **M3-002:** a non-minimal infeasibility certificate in the corpus (the M4 grading oracle) — refuted by its own proof text; fixed with a 5-staff/3-senior frame, exactly one fixture hash changed.
- **M3-003:** the SECURITY DEFINER prune was a general within-tenant per-version DELETE primitive irreversibly disarming D-1b (now refuses current/unpublished versions); D-15a lacked an INSERT arm so a published version's content set could GROW, and three service mutators (one with neither capability check nor audit) reached published versions — closed under FAD-22.
- **M3-004:** the CAS was not atomic at READ COMMITTED — 11/12 concurrent rounds BOTH writers won under a sequential-only proof; two adjacent race shapes failed wrongly (404) or merged silently; the override reason was decorative on both sides. Fixed with `pg_advisory_xact_lock` inside `compareAndSet`, 12-round DB-asserted race tests, falsifiability-before-wiring, both-sides reason enforcement.
- **M3-008:** a raw NUL byte rendering the central step-06 file binary-invisible to diff review (the exact class the same commit fixed elsewhere); a factually false NOT-EVALUABLE reason (`CallSpacing` — `is_on_call` shipped in M2; now EVALUATED with 13 tests).

Zero-blocking reviews (M3-005/006/007) still produced substantive non-blocking rounds, all closed pre-merge (no-op writes audited as changes; a ledger note recording an unmade measurement; a per-clause claim made TRUE by crafting legally-reachable decoupled states rather than softened).

## 4. Orchestrator findings (what the paired reviews did not catch)

O-1 (M3-001): the SBX-001 real-session overclaim. The masked-validator lesson from M2 held (exit codes checked directly throughout). O-1 (M3-008): fixture-regression's fixed seed 8675309 failing on the pre-existing nested fixed port 55455 — recorded twice in prior milestones, now FIXED (digest-derived nested port; 102/102). The E-2 preview-port collision diagnosed from two red-case GREEN-arm failures that reproduced 18/18 in isolation.

## 5. Tests and validators at close (on main, exit-code checked)

**1384 tests / 109 files · 13/13 gates (the 13th is M3-002's rule-node-mapping gate) · 21/21 red cases · fixture-regression 102/102 (13 fixed seeds + rotating, both shuffles, standalone sweep, baseline control) · SBX battery 6/6 PASS all falsifiable, 0 vacuous — SBX-004 sweep 308 readings across 7 contexts, 44/44 tables observed, 0 wrong-tenant rows · migrations 0001..0011 up→down→up→down→up CLEAN · NR-14: zero tree modifications after the full battery (no restores) · plan validator 36/36 · architecture validator 95/95 · research validator PASS.**

## 6. Migration results

Five new migrations this milestone: `0007` authn (sessions/invitations/user_mfa/password_reset_tokens) · `0008` typed rules (FAD-21) · `0009` schedule/publication spine (11 tables incl. `current_published_assignments`, D-15 triggers with FAD-22 INSERT coverage, `groups.timezone`) · `0010` settings/locations · `0011` period-length CHECK (367 days refused at the DB, asserted by constraint name) + audit read scope. Every CREATE TABLE carries ENABLE+FORCE RLS+policy in-file (gate-enforced); composite tenant FKs throughout; full cycle clean at every acceptance and at close.

## 7. V-01 through V-16 (and the fuller table), SBX-018, QA-SCH

- **V-harness: ALL GREEN — the complete SPEC-05 §8 table V-01..V-19** (the authorization's V-01..16 plus the spec's dated V-15b/c and V-17..19 additions; running the subset would have weakened the spec's own proof). 23 rows individually reported; V-18 enumerates all 13 frozen columns from `information_schema`; non-vacuity proven by three subject mutations each failing the harness naming its row (reviewer-run). Standalone AND in the full battery at every acceptance.
- **SBX-018: PASS, FALSIFIABLE, gate-required**, nine contract fields, filed in EV-M3-PUBLICATION.
- **QA-SCH manual-path battery: 9 PASS · 6 PARTIAL (each naming its unclaimed half and owning milestone) · 1 N/A**, filed in EV-M3-INTEGRATION.

## 8. Browser and accessibility evidence

Schedule authoring, publication review/history/comparison, and the personal + daily staff views were all exercised in a real browser (Playwright/Chromium) with retained screenshots across desktop, mobile, and 320px, plus keyboard journeys, loading/empty/error/validation/permission-denied states — per-packet bundles (EV-M3-AUTHORING-UX 4-state × viewport sets; EV-M3-SETTINGS 22 screenshots; EV-M3-PUBLICATION-UX; EV-M3-STAFF-VIEWS) and the consolidated EV-M3-INTEGRATION set. axe (including best-practice) green at both standing viewports on every surface; I-13 zero-request red-cased; request budgets: 38+ interactions recorded at both viewports, gate-enforced. **SPEC-14: `A` cells executed; the 10 `M` cells requiring real assistive-technology sessions are retained as honestly UNCLAIMED** (EV-8 dependency, owned at M6) — no AT combination is claimed as supported anywhere.

## 9. Tenant and group isolation; authorization and entitlements

Zero wrong-tenant rows in every probe by every agent across the milestone (final: 308 readings, 44/44 tables non-vacuous). The cross-tenant exception census is unchanged: FAD-14 maintenance plane + `app_breakglass`, both pinned per-cell in the sweep. Notable isolation results: self-scoping survived a viewer granted all 25 group capabilities and a 38-capability evaluator drive (L5.1 deny with an owner-control ALLOW arm); byte-identical 404s with no EX-2 disclosure path on staff views; cross-group settings/rules/schedule denial proven per role at every packet. Authorization freshness (I-19) proven mid-flight (revocation denies publication in-transaction; composed re-proof at M3-008). Capability additions this milestone: action keys only, all under existing capabilities (CAP-009/014/020), the 58-capability baseline unchanged — `identity.reset_mfa`, `identity.administer_sessions`, `schedule.period.administer`, `schedule.version.edit`, three settings keys, two staff read keys, `group.holiday_calendar.read`, `audit.read` (grant-only, held by zero roles by default).

## 10. Publication, immutability, audit, outbox

Published-version immutability proven at the database as every role including `app_migrator` (trigger-level refusals; TRUNCATE refused; no cascade paths; column grants block repointing), with FAD-22's INSERT arm closing set-growth. D-16 single-current (tenant-qualified), D-17 idempotency (one key domain; replay returns the recorded outcome; publish-once proven sequentially, concurrently ×12, and at the UI). Simultaneous publication: same-version race → one winner one explicit loser one outbox event; different-version race → required CAS refuses (`CURRENT_VERSION_MOVED`, version number rendered); per-membership publications don't contend (V-15b). **I-11 proven both halves**: pre-commit outbox failure rolls the publication back whole; post-commit delivery failure never unwinds it. Notification intents flow only through the transactional outbox with scalar payloads; **no production notification was sent; no real customer, staff, or patient data was used anywhere** (synthetic fixtures only). Audit: every mutation through the chain API in the same unit of work; chain verifies 0/1/0 per organization after every battery; the group-scope verification false-alarm fixed; the audit READ surface now exists (grant-only) and backs the publication audit display.

## 11. Architecture decisions and deviations (FADs 18–27)

FAD-18 `user_mfa` AES-256-GCM AAD-bound · FAD-19 scrypt (recorded side-channel limitation) · FAD-20 `password_reset_tokens` namespace · FAD-21 pattern/staff rules are categories of the typed model · FAD-22 SPEC-05 strengthened (D-15a INSERT; required publication CAS; one idempotency-key domain) · FAD-23 eligibility three-state (absent never renders as ineligible; override reason on the known-missing arm) · FAD-24 settings vocabulary + no-op writes unaudited · FAD-25 calendar-key ruling (self-scoped read keys; **write never implies read** adopted as standing rule) · FAD-26 sign-off route + review-digest CAS · FAD-27 step-06 rulings (fail-closed unevaluable HARD; the 6/24 kind table of record; `AvoidDate` start-date semantics pinned with the attribution question recorded). Doc 06 §3.2 amended four times (dated); SPEC-05 amended once (dated, strengthening). No ADR was edited silently; no invariant weakened.

## 12. Risks closed and opened

**NR-14 RETIRED** (the redesign proves itself: plain battery → zero tree modifications, writers discovered not hand-kept, red-cased; the restore discipline retired). **E-2 fully closed** (preview + nested port derivation; the twice-recurring 55455 seed fixed). **NR-4 stays elevated through M4** — richest data yet: REVISE ×5 / zero-blocking ×3, with the zero-blocking trend on the later-issued packets suggesting the disciplines transfer, and every blocker still reviewer-probe-found (details in RISK-REGISTER 2026-08-05). No new risk opened.

## 13. Carried items — all named, all owned

1. **Rule-kind evaluation semantics (24 NOT-EVALUABLE kinds; 11 one-ruling-away)** → M4 (solver + explanation milestone; the per-kind ruling requests are in `EV-M3-INTEGRATION/step-06-node-kinds.md`). Until each ruling, an active HARD rule of that kind blocks publication fail-closed (FAD-27) with audited disable as the escape.
2. **`AvoidDate` overnight-attribution question** → owner/M4 ruling (semantics pinned start-date-equality today, test-asserted).
3. **SPEC-14 `M` cells (10)** → M6, EV-8 (owner-provided AT sessions); honestly unclaimed until then.
4. **Settings-page consolidation** (two "Group settings" surfaces) → disclosed NOT DONE with reasons; owner: the M4-entry hygiene window or M6 UX-completion family; capability-neutral.
5. **Retroactive-history authoring** → **product decision put to you now** (§15): approve/reject the administrative capability; if approved, M6 admin-completeness family (mapping and gates recorded in doc 32 §2.13).
6. **Timezone display-semantics question** (change with published schedules: original wall time vs new-zone rendering) → recorded from M3-007; proven no stored instant moves; owner ruling welcome, default stands.
7. **CAP-020's three-view completion + legends/filters** → M6 per the roadmap (personal + daily views shipped).
8. **In-force catalogue reads** → M4 (S-03 ruling, restated). **Request-until enforcement** → M5; **picklist-access enforcement** → M9 (settings authored and stored at M3-007).
9. Standing conditions unchanged: external architecture re-review blocks beta (V-04); FAD-7 CI conditions; EV-1 vendor specs; G-ARCH remains open until SBX-011/013/014b/022/023/028 at their milestones.

## 14. Control-document audit

| Document | Updated |
|---|---|
| PROJECT-STATUS | **yes** — M3 complete, state at close, M4 boundary |
| OPUS-AGENT-RUNBOOK | **yes** — eight task rows with verdict paths; NR-14 restore discipline retired |
| TEST-TRACEABILITY | **yes** — eight execution rows with measured figures |
| EVIDENCE-INDEX | **yes** — eight EV-M3 bundles |
| ARCHITECTURE-DECISIONS | **yes** — FAD-18..27 |
| RISK-REGISTER | **yes** — NR-14 retired, NR-4 re-evidenced, E-2 closed |
| FEATURE-PARITY-MATRIX + doc 06 rows | **yes** — 14 verified / 3 in-progress / 41 not-started, dated citations |
| IMPLEMENTATION-ROADMAP | **yes** — M3 COMPLETE with honest scope notes |
| CHANGELOG | **yes** — six M3 entries |
| ASSUMPTIONS / PRODUCT-DECISIONS / OPEN-QUESTIONS / ORCHESTRATION | no change required (FA-1..6 unchanged; no product decision altered — PO-DEC-01/18 defaults applied as defaults; the orchestration model validated again by use) |

## 15. M3 exit verdict

The authorization required the complete roadmap M3 outcome — schema, API, **and** the three experiences — with the full evidence slate. **All delivered: PASSED.** Specifically: V-01..V-16 (and the fuller V-19 table) green · every named proof standalone + full battery · SBX-018 filed · QA-SCH executed · published immutability proven at the database · idempotency and simultaneous publication proven · cross-tenant/cross-group denial proven · authorization/entitlement freshness proven · qualification eligibility and expiry proven · outbox intents with I-11 proven unable to roll back publication · authoring and staff views inspected in a real browser with all states evidenced · accessibility automation passing with manual evidence honestly unclaimed · migration cycle clean · fixture-regression, SBX, gates, red cases, validators all green · no production notification · no real data · **no capability dropped** · manual scheduling described only as override/recovery/fixed-assignment-input/development-stage functionality throughout (grep-asserted at review) · **M4 automated scheduling remains mandatory for production (I-05)**. One decision for you now: **retroactive-history authoring** (§13.5).

## 16. Recommendation concerning M4, proposed first packets, and the authorization prompt

**M4 is recommended.** Every input it needs exists and is proven: the typed rule model with a deterministic compiler and a graded corpus, the publication spine it must feed, the demand model, profiles/qualifications, real sessions, and an evidence machinery that has now caught real defects in every milestone. M4 is the highest-risk milestone (solver correctness, the I-05 production mechanism); NR-4's mandatory independent review stays.

- **OPUS-M4-001 — Solver runtime boundary + input assembly.** The solver worker deployment per SPEC-04 §1 (own image, no DB credential, RPC), the canonical input assembly (compiled rules + periods + requirements + profiles + qualifications + pins; in-force catalogue reads land here per S-03), reproducibility record fields, and the SPEC-04 §2 cancellation/timeout contract. No optimization yet — the boundary first, falsifiable end-to-end with a stub solve. Critical class.
- **OPUS-M4-002 — E1 feasibility engine against the corpus.** The first real solve: hard-constraint satisfaction over the evaluated rule semantics, `B-feasible-*` all `hard_violations = 0`, `B-infeasible-*` correctly proven infeasible with the minimal-certificate explanations scored against the corpus oracles; the 11 one-ruling-away kinds ruled and evaluated as part of this packet's semantics work (SBX-015 subset). Critical class.
- **OPUS-M4-003 — Build lifecycle + demand/build UI.** The 16-state build lifecycle, submission/monitor UI, progressive builds around pins (SBX-017), candidate comparison (D-4 per-configuration), conflict taxonomy + quality report (PO-DEC-13 default), explanation tiers 1–2, and the step-06 unevaluable set shrinking as kinds gain semantics. Integration packet pre-declared.

**Exact authorization prompt to begin M4:**

> Begin Milestone M4 against the frozen M3 checkpoint tagged `milestone/M3`. Treat `docs/fable/33-m3-exit-report.md` as the authoritative M3 exit record. Issue OPUS-M4-001 first and alone, then OPUS-M4-002 and OPUS-M4-003 per the M3 exit report, under the same rules as M3: entry verification with exit codes checked, finalized packets before issuance, isolated worktrees with derived ports, independent second review for every task, reviewer-authored adversarial probes, fixture-regression and the SBX battery at acceptance, standalone plus full verification of every named proof, serialized merges with complete validation after each, a pre-declared integration packet, escalation rather than improvisation, evidence under docs/evidence/EV-M4-*, and every additional packet required for the complete M4 roadmap outcome (SBX-015/016/017; all feasible corpus fixtures at zero hard violations; every infeasible fixture correctly proven and explained; the E2 exit evidence). The solver must never run in the API process, must hold no database credential, and manual scheduling remains override/recovery/fixed-input only. Produce the M4 exit report, tag `milestone/M4`, and stop before M5.

---

**Stopping here per the authorization. M4 begins only on your explicit instruction.**
