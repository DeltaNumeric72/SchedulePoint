# 16 — Implementation Roadmap

**The complete development roadmap: 13 milestones (M0–M12) in four stages, covering all 58 production capabilities.** This is the artifact the project lacked. It is built from vertical, user-outcome slices — there are no "build backend" milestones — and it is **not** a smallest-possible-MVP plan: the end goal is high parity with the full baseline, and sequencing exists to manage risk, not to shrink scope.

> **AMENDED 2026-08-01 (delegated authority — [21-decision-resolution.md](21-decision-resolution.md)).** Three deltas: **(1)** all technology gates carry decided selections (21 §3), so M0's spikes are **confirmation runs** of named choices, not evaluations; **(2)** M1's entry criterion is now *"internal-verification findings dispositioned"* — the **external** independent re-review is repositioned to **block controlled-beta entry** (M10 exit review) rather than M1 — it remains REQUIRED (V-04); **(3)** all pending product decisions are resolved, so no milestone carries a decision-pending entry condition. Milestone content is otherwise unchanged.

## 1. Standing rules

- **R-1 Vertical slices only.** Every slice = migration + domain + server authorization + API + UI (with loading/empty/error/permission-denied states) + audit events + unit/integration/Playwright tests + doc update. The playbook's definition-of-done appendix is adopted verbatim and extended by the runbook.
- **R-2 Sequencing never changes scope.** Anything deferred here remains `REQUIRED FOR PRODUCTION` per report 19; deferral out of the product requires a baseline change by you. (Supersedes the playbook Phase-18 deferral list.)
- **R-3 Proof before dependence.** A milestone may not build on a mechanism whose harness hasn't passed (isolation → everything; publication triggers → marketplace; turn transaction → picklist UI).
- **R-4 Gates, not deletions.** Schedule pressure is relieved by re-sequencing or adding capacity, never by dropping a capability or weakening a test (RISK-21).
- **R-5 Every milestone exits through the quality-gate checklist** (§5) with evidence filed under `docs/evidence/` and [06](06-feature-parity-matrix.md) statuses updated.
- **R-6 Pending decisions implement working defaults only,** with the pending-decision CI guard preventing non-default branches from acquiring tables/APIs.

## 2. Stage map

```
Stage 0  PROVE      M0 spikes+scaffold → M1 tenancy/identity/audit kernel
Stage A  SCHEDULE   M2 catalogue+rules → M3 manual schedule+publication → M4 solver
                    → M5 requests+vacation → M6 fairness+views  == internal alpha
Stage B  COORDINATE M7 notifications → M8 marketplace → M9 picklist prep+LIVE-SIM
                    → M10 picklist execution  == controlled-beta entry
Stage C  HARDEN     M11 reports/documents/calendar/integration → M12 production hardening
                    == G-PROD readiness (gates pass on evidence, not on this plan)
```

Dependencies are honest: M4 needs M2's rules and M3's publication pipeline; M8 needs M3's version binding and M7's fan-out; M10 needs M7's ladder and M9's LIVE-SIM. M7 can start in parallel with M5–M6. The internal verification review ran during planning and gates M1's schema freeze via its dispositioned findings; the external re-review is required and blocks beta entry (M10 exit; V-04).

## 3. Milestones

Format per milestone: objective · user outcome · slices · key exclusions · entry/exit. Capability coverage per [06](06-feature-parity-matrix.md) Roadmap column; every exit includes the §5 checklist.

### M0 — Prove the foundations (no product features)
**Objective:** close the gating unknowns; stand up the delivery machine. **User outcome:** none directly — this milestone exists so every later one rests on proof.
**Slices:**
1. **SP-A Tenant-isolation unit-of-work spike** — TDG-02/03: chosen data layer issues `SET LOCAL` in caller-controlled transactions; exclusion constraints/partial-unique/triggers expressible; transaction-level pooling; SPEC-01 T-07..15 harness green under forced exceptions/cancellations/pool reuse across two orgs. **The first Opus task ([20](20-recommendation.md) §4).**
2. SP-B Web-framework spike (TDG-01) — middleware composition (context, authz, correlation), streaming, WebSocket co-existence.
3. SP-C = E0 solver round-trip spike (TDG-11; [12](12-scheduling-engine-plan.md) §3).
4. SP-D Job-queue durable-lease spike (TDG-04).
5. SP-E Design-system evaluation (TDG-14 — a library fighting accessible defaults is disqualified) + **UX brief** (navigation, grid concept, tokens, status language, confirmation-friction patterns; original design, no source visuals) — closes audit finding F-07.
6. Scaffold: monorepo (pnpm workspaces + `solver/`), CI with the full [15](15-testing-strategy.md) §4 gate battery, containerised local env, seeded synthetic data, secret handling, install adversarially-linted CLAUDE.md/AGENTS.md from the drafts.
**Exit:** TDG-01/02/03/04/11/14 selections **confirmed by spike evidence** (a failed confirmation reopens only that row per SPEC-15's standing rule); CI green including SP-HR-1/2 guards; ADR for each confirmed gate.

### M1 — Tenancy, identity, authorization, audit kernel
**Objective:** the platform every feature stands on. **User outcome:** an org admin creates an organization and groups, invites users, assigns per-membership roles; users sign in (MFA), switch groups, edit profiles; every action lands in a queryable audit log.
**Slices:** org+group creation · SPEC-01 context middleware end-to-end · memberships+roles+grants with SPEC-06 evaluator and generated cross-product tests · entitlement records + module gating (CAP-057) · authn (password+MFA, sessions, invitation/activation, reset) · login-email change (CAR-027) · audit events + hash chain (A1) + audit query UI · MULTI env + SBX-001/002/004/005/006 · outbox + job runner (SP-D productionised).
**Entry:** M0 exit; **internal-verification findings dispositioned** (schema-freeze condition — [21](21-decision-resolution.md) FD-2). **Exit:** isolation, authz, and audit harnesses green; QA-TEN/QA-AUTH battery passing; G-ARCH SBX subset for tenancy executed and filed.

### M2 — Scheduling structure a scheduler can author
**Objective:** the catalogue and rule model, complete. **User outcome:** a scheduler defines shift types (four flags), shift/staff/valid groups, FTE/work profiles, qualifications, holidays, and authors versioned pattern/staff/position rules — and sees them validated.
**Slices:** shift-type catalogue · groups + valid combinations · effective-dated work profiles/FTE · qualifications with expiry (PO-DEC-12 default) · group settings incl. holidays, request-until, picklist access, timezone · rule authoring UI over the typed AST + compiler (unmapped node fails CI) · **B-\* benchmark corpus built** (E1 fixture half) · site attribute (PO-DEC-01 default).
**Exit:** rule round-trip (author → compile → re-validate) proven; corpus committed; catalogue QA cases pass.

### M3 — Manual schedule to published version (the spine)
**Objective:** SPEC-05 publication pipeline, proven, with manual content. **User outcome:** a scheduler creates a period, manually assigns staff (credits independent of assignments, per-cell provenance), publishes an immutable version; staff see their schedules; a revert publishes forward; affected staff are notified (email channel minimum).
**Slices:** periods · identity/snapshot assignment model + grid (virtualized) + cell editor + pinning · **publication with D-15 triggers + V-01..16 harness** · version browsing/diff/revert-forward · daily sheet + my-schedule views · change audit + affected-staff diff notification (CAP-027; email via outbox) · partial-view alternative for AT (tabular).
**Exit:** V-01..16 green; SBX-018 executed; a published version is provably immutable (attempted mutation fails at the database); QA-SCH battery for manual paths passing.

### M4 — Automated scheduling (E1+E2)
**Objective:** the production scheduling mechanism (I-05). **User outcome:** a scheduler runs a build over demand+rules+pins, watches the 16-state lifecycle, gets zero-hard-violation candidates or a bounded infeasibility explanation, compares candidates, and feeds the winner into M3's publication.
**Slices:** solver worker deployment (own image, no DB credential, RPC) · demand definition UI · build submission/monitor · progressive builds around pins · conflict taxonomy + quality report (PO-DEC-13 default) · explanation tiers 1–2 · reproducibility record.
**Exit:** SBX-015/016/017; corpus: all feasible fixtures `hard_violations = 0`, all `B-infeasible-*` correctly proven+explained; E2 exit evidence ([12](12-scheduling-engine-plan.md)).

### M5 — Requests and vacation
**Objective:** SPEC-08 complete. **User outcome:** staff submit ON/OFF/No-Call/preferences and vacation (quota/grant + open modes); schedulers approve individually/in batch with advisory over-quota + audited override; approved time off constrains builds via the projection; vacation commits to the schedule idempotently and reversibly with graduated confirmation.
**Slices:** request aggregate+subtypes · request UIs + status history + withdrawal · approvals (individual, batch) · vacation grants/selections + variance display · D-21 last-unit race protection · commit/reverse (new schedule version) · request-until gating · solver projection integration · contacts directory (CAP-042, minimised PII — needed by approvals UX).
**Exit:** R-01..14 green; SBX-010/011/012/013 executed; QA-REQ battery passing.

### M6 — Fairness, statistics, alpha completeness == **internal functional alpha**
**Objective:** close Stage A. **User outcome:** schedulers see fairness statistics/variance with a documented formula; E3 quality/weights tuning; three schedule views complete; on-call board (CAP-044); a11y matrix current for all shipped components.
**Slices:** fairness stats + variance UI · E3 (weights, tier-3/4 explanations, candidate comparison, perf targets) · shift/staff/date view completion + legends/filters · on-call board + Telecom role · PERF env + first benchmark bands frozen · SBX-030/031 subset.
**Exit:** alpha review against report 19's alpha definition (manual scheduling may no longer be the only mechanism — it isn't, M4 shipped); A11Y evidence for shipped surfaces (EV-8 needed by now).

### M7 — Notification platform (parallel-start after M1)
**Objective:** SPEC-07 complete. **User outcome:** users set channel preferences; the system delivers email/SMS/voice/push with retry, honest ambiguity, escalation ladders, durable acknowledgements, and a per-user delivery log; safety-critical class overrides quiet hours.
**Slices:** intents/logical-deliveries/attempts model · provider ports + selection (TDG-06; **processor register created**) · push registrations (encrypted material) + consent · escalation policies + conditional-claim stepping · acknowledgement UX · delivery log UI · callback verification · notification-class matrix.
**Exit:** N-01..15 green (fault-injected fakes; real sandboxes as EV-4 lands); SBX-030a/b; I-20 language verified by validator.

### M8 — Marketplace
**Objective:** SPEC-13 complete. **User outcome:** staff post/claim opportunities (fan-out, staff-over-locum window), propose/accept swaps and transfers with optional scheduler review; every transfer lands as a new version; impersonation ships for support (CAP-010); bulk messaging (CAP-043).
**Slices:** opportunity board + claims (version-bound CAS) · swap/transfer flows + review policy per group · staff-over-locum window · impersonation with safeguards · bulk messaging + group identity (CAP-056).
**Exit:** M-01..12 green incl. republication races; SBX-013b/014b/014c; QA-OPP battery.

### M9 — Picklist preparation + LIVE-SIM
**Objective:** everything before a live turn. **User outcome:** schedulers prepare picklists (import via ingestion boundary or manual vocabulary-constrained entry), order derives from the master schedule, lock, choose mode (paper/manual/integrated); the enclave + vocabulary + quarantine exist.
**Slices:** picklist/participant/work-item model · **raw-ingress enclave** + vocabulary admin + fast-add path + quarantine review UI · pick-order derivation · modes · **LIVE-SIM environment** (P-B) · monitor skeleton.
**Exit:** SBX-020 executed; SPEC-03 I-01..12 subset green; enclave canary sweep (SBX-029) first full run; LIVE-SIM meta-test provisions clean.

### M10 — Picklist execution == **controlled-beta entry**
**Objective:** the signature feature, proven under contention ([13](13-picklist-plan.md) P-C..P-F). **User outcome:** a full draft day runs end-to-end: turns open on server clock, participants/proxies select with I-13 confirmation, escalation ladders fire, admins pause/skip/intervene (audited), completion publishes daily assignments, corrections are separate audited operations — under real concurrency, with AT-completable timed turns.
**Slices:** turn machine + selection transaction + D-3a/b/c · coordinator + event relay + reconnect/resync · timers + ladder integration · proxy turns · admin intervention + monitor live · completion → daily assignments · correction flow · AX-1..5.
**Exit:** P-01..15 green (incl. ≥50-trial batteries); SBX-021..027 + SBX-033 filed; **external independent architecture review received, verdict upgraded, findings dispositioned (REQUIRED, blocking — [21](21-decision-resolution.md) FD-2/V-04)**; beta-readiness review against report 24's G-BETA (never-waivable set complete; waivable items disclosed).

### M11 — Reports, documents, calendar, integration framework
**Objective:** the remaining product surface. **User outcome:** six report classes as snapshot-bound artifacts with print/export/share; document repository with retention; calendar feeds (safe tokens) and schedule events; hospital integration framework live against canonical-schema fixtures (INTEG env); incident-response plan written.
**Slices:** report runs/snapshots/shares + 3-point authz · six report classes + statistics export · print styling · documents + categories + retention · calendar feeds + rotation/revocation · calendar events · integration framework (CAP-055) + connector scaffolding (certification EV-1-gated) · IR plan + first runbooks.
**Exit:** F-01..14 green; SBX-031a/b/c, SBX-028; QA-RPT battery.

### M12 — Production hardening
**Objective:** everything G-PROD demands that isn't a feature. **User outcome (operator):** the system can be broken, restored, audited, and incident-managed with evidence.
**Slices:** A2 audit replication (separate trust domain; TDG-09 object-lock) · DR: restore rehearsal + failover drill + audit-integrity verification (SBX-035) · pen test + remediation · tabletop exercise · remaining runbooks · chain-write throughput benchmark (RISK-31) · data-retention/erasure workflows · SBOM/signing/admission policy complete · load tests at target scale · G-PROD evidence assembly against report 24's 14-item bar.
**Exit:** G-PROD gate review — **passes only on filed evidence; this roadmap never claims it**.

**Post-M12 (sequenced, in scope):** connector certifications per vendor as EV-1 specs arrive (CAP-061/063/064/065; G-CONN per connector); SSO rollout per customer; hybrid solver evolution per benchmark need.

## 4. Capability coverage check

All 58 capabilities appear in §3 exactly per the Roadmap column of [06](06-feature-parity-matrix.md); the four post-beta/post-production connector items are the only post-M12 capabilities, matching report 19's own milestone assignments. Continuous capabilities (050/066/067/068) are CI-gated from M0. **No capability is unowned; none is dropped.**

## 5. Milestone exit checklist (uniform)

1. Acceptance criteria of every slice met (traceable to CAP/SPEC IDs)
2. All named harnesses/SBX tests for the milestone green, evidence filed under `docs/evidence/`
3. Browser verification at desktop + mobile; a11y matrix updated; axe gate green
4. Tenant isolation regression suite green; no route without policy
5. Audit events verified for every new mutation
6. No unexplained architecture/schema deviation (runbook §6 review passed)
7. Docs + [06](06-feature-parity-matrix.md) statuses + [control/](control/) documents updated; CHANGELOG entry
8. Known limitations recorded; no unresolved Critical defects; rollback path for every migration identified
9. Milestone review held; next milestone's entry criteria confirmed

## 6a. Final implementation sequence (compact reference)

| M | Objective | Depends on | Entry gate | Exit gate / proof | Parity outcome |
|---|---|---|---|---|---|
| M0 | Confirm technology selections; scaffold; UX brief | — | Implementation authorization | Spike evidence for TDG-01/02/03/04/11/14; CI gate battery green | none (foundational) |
| M1 | Tenancy/identity/authz/audit kernel | M0 | Internal-verification findings dispositioned | SPEC-01 T-tests, SPEC-06 cross-product, SPEC-11 chain subset; SBX-001/002/004/005/006 | CAP-001..010, 027(part), 057 implemented |
| M2 | Catalogue, rules, profiles, qualifications | M1 | M1 exit | Rule AST round-trip; B-* corpus committed | CAP-004, 011–013, 016, 058 |
| M3 | Manual schedule → immutable published version | M2 | M2 exit | SPEC-05 V-01..16; SBX-018 | CAP-014, 019, 020(part), 027 |
| M4 | Automated generation (E1+E2) | M2, M3 | M3 exit | SBX-015/016/017; zero hard violations on corpus | CAP-015, 017, 059 |
| M5 | Requests + vacation | M1 (M3 for commit) | M1 exit | SPEC-08 R-01..14; SBX-010..013 | CAP-021–023, 042 |
| M6 | Fairness, stats, views — **alpha** | M4, M5 | M4+M5 exits | SBX-030/031 subset; bands frozen ≤ report-21 targets | CAP-013, 018, 020, 044, 045 |
| M7 | Notification platform (∥ M5–M6) | M1 | M1 exit | SPEC-07 N-01..15 vs fault-injected fakes; SBX-030a/b | CAP-040, 041, 056(part) |
| M8 | Marketplace + impersonation + bulk messaging | M3, M7 | M6+M7 exits | SPEC-13 M-01..12; SBX-013b/014b/014c | CAP-010, 024–026, 043 |
| M9 | Picklist preparation + enclave + LIVE-SIM | M3, M7 | M8 exit (or ∥ late M8) | SBX-020; SPEC-03 I-subset; SBX-029 first sweep; LIVE-SIM meta-test | CAP-030, 060, 062(part) |
| M10 | Picklist execution — **beta entry** | M9, M7 | M9 exit; **external review passed (required, blocking; V-04)** | SPEC-02 P-01..15 (≥50-trial races); SBX-021..027, 033; G-BETA review | CAP-031–034 |
| M11 | Reports, documents, calendar, integration fw, IR plan | M6 | M6 exit (∥ M9–M10 where independent) | SPEC-09 F-01..14; SBX-031a/b/c, 028 | CAP-046–049, 055, 056, 062 |
| M12 | Production hardening | all | M10+M11 exits | SBX-035 DR rehearsal; pen test; tabletop; A2 replication; G-PROD evidence review | CAP-051, 061-prep; G-PROD |
| post-M12 | Connector certifications (per EV-1 spec) | M11 | Vendor spec in hand | SBX-028/029 per connector; G-CONN | CAP-061, 063–065 |

## 6. Estimate discipline

No calendar estimates are stated in this document on purpose: velocity data does not exist yet. After M0 and M1 complete, the milestone review sets a rolling forecast from measured slice throughput; before that, any date would be decoration. What the plan does fix is **order and proof obligations**, which are the schedule's real drivers.
