# CHANGELOG

## 2026-08-04 — Milestone M2 COMPLETE (4/4 accepted)
- M2-002 (ff2e67b, first UI slice) and M2-003 (567964c) merged after REVISE→delta-APPROVE and APPROVE-WITH-FOLLOW-UPS cycles; M2-004 integration (fce095c) composed the join table, consolidated fixtures per D-1, fixed the sequence::text class incl. production audit verification, closed the port-collision hazard, and landed the request-budget ledger under the budget=2 ruling.
- Review findings of record this half: a vacuous cross-group proof arm (a CAR-001-class policy mutation sailed through — now pinned as a red case), an INSERT-blind capability gate, effective dating that was created_at in disguise, an arbitrary-row read (the S-01 class, twice more — once reintroduced by the person who had just read the warning, caught by the structural scan), a version counter that wasn't a control, reachable retroactive history creation, silent weekday-target loss on supersession, and a fault-masking catch. All closed with regression evidence.
- One session-limit interruption (both agents) recovered per protocol with zero loss. FAD-16/17 recorded; doc 06 amended thrice (dated). NR-13 retired; NR-14 opened low; E-1/E-2 closed. Parity: first 10 rows move (8 verified, 2 in-progress).
- Frozen M2 checkpoint = the exit-report commit, tagged milestone/M2 (milestone/M1 retro-tagged at b051193 per 24 §E — the tag was missed at M1 close, disclosed).

## 2026-08-03 — OPUS-M2-002 and OPUS-M2-003 issued in parallel
- Packets revalidated against the actual M2-001 outcome; binding deltas recorded as 30-m2-task-packets §7 (FAD-15 fixture discipline concretely named, TENANT_TABLES + SBX-004 non-vacuous coverage for every new tenant table, fixture-regression at submission and acceptance, ProbeFalsified vacuity discipline, restore-by-id).
- FAD-16 recorded and doc 06 §3.2 amended (dated, additive): extended shift_types field set with CHECK-constrained display tokens, shift_type_weekday_demand, monotonic groups.pick_position_count.
- Disjoint globs re-verified; shared-surface ownership table §5 unchanged; shift_type_qualifications reserved for the integration packet. Branches opus/m2-002-catalogue and opus/m2-003-profiles.

## 2026-08-03 — OPUS-M2-001 accepted and merged
- OPUS-M2-001 ACCEPTED (bc61ee7) after: phase-A NR-13 measurement with mid-task FAD-15 ratification; a tooling-outage interruption recovered per protocol; an orchestrator diagnosis dissolving a suspected kernel-guard defect (superuser arrangements fire capability triggers — the control working); independent second review REVISE → delta REVISE → APPROVE WITH FOLLOW-UPS across R-01..R-12 / D-01..D-09 / E-01..E-06; and the rotating seed catching a seventh test coupling at acceptance time (FAD-15 ruling 3's first live exercise).
- Landed: fixture-isolation refactor per FAD-15 (as corrected b9755d1), the fixture-regression acceptance gate, the MULTI factory fixture, the SPEC-16 SBX harness with ProbeFalsified-sentinel vacuity detection and per-scenario retained artifacts, and the G-ARCH tenancy subset evidence (SBX-001/002/004 PASS; 005 partial; 006 blocked on authn — named, not hidden). G-ARCH remains open (six non-tenancy SBX tests at later milestones).
- Review findings of record: the vacuity detector originally accepted any probe throw as falsifiability; five declared artifacts were unwritten with nothing checking; the five-role sweep's refusal cascade wrote false causes into shipped evidence; two probes reproduced the absence-vacuity shape inside the detector built to kill it. All closed with red cases.
- M2-002/003 remain NOT ISSUED pending packet revalidation.

## 2026-08-03 — M2 begun; OPUS-M2-001 issued
- M2 authorized by the owner against frozen M1 checkpoint b051193. Three packets finalized in runbook format (docs/fable/30-m2-task-packets.md, commit 73cd212); validators green at authoring (plan 36/36, arch 95/95, research PASS).
- OPUS-M2-001 issued: NR-13 fixture-isolation measured decision first, then MULTI provisioning, then the SPEC-16 SBX harness executing the G-ARCH tenancy subset (SBX-001/002/004/005/006) against the M1 kernel. Branch `opus/m2-001-sbx-harness`.
- Packet rulings recorded in the packet doc: SBX-002 reinterpreted per its capability mapping (CAP-006/CAP-057), picklist arm re-executes at its milestone; authn-dependent SBX-005/006 sub-scenarios report EVIDENCE_BLOCKED per SPEC-16 §7 (the authn subsystem was a roadmap M1 slice that no issued M1 packet contained — carried, not hidden); shift_type_qualifications pre-assigned to a prepared integration packet; M2-003 API-first (UI follows M2-002's foundation).
- OPUS-M2-002/003 NOT ISSUED — blocked on M2-001 acceptance, then revalidation.

## 2026-08-03 — Milestone M1 COMPLETE (4/4 accepted)
- Tenancy kernel (356ddf5), audit chain + outbox with TDG-04 confirmed (946fc72), authorization evaluator + kernel integration (f547e90). Exit report: docs/fable/29-m1-exit-report.md.
- A fourth task (OPUS-M1-004, FAD-13) was added mid-milestone: the two parallel packets left the integration surface unowned, and the merge conflicted exactly where audit emission meets real authorization. Composed rather than hand-resolved, with its own review.
- Three of four tasks returned REVISE from independent second review; every blocking finding came from a reviewer's own database probes (arbitrary-row entitlement read 404'ing an organization; audit chain reporting intact after tail truncation; outbox double-delivering; a flagship isolation test satisfiable by the defect it existed to catch). Orchestrator rerun additionally caught a named-condition proof passing in-suite and failing 5/5 standalone.
- FAD-11/12/13/14 recorded; SPEC-01 §7.1/§4.3 amended; NR-9 retired, NR-13 (shared-fixture coupling) opened, FA-3 discharged.
- M1 exit PASSED WITH ONE CARRIED ITEM (G-ARCH SBX tenancy subset — harness does not exist; opens M2-001). M2 NOT authorized.

## 2026-08-02 — M1 begun; OPUS-M1-001 accepted
- M1 authorized by the owner against checkpoint b49d3dd. OPUS-M1-001 (tenancy schema + SPEC-01 context middleware + production unit-of-work) ACCEPTED and squash-merged (356ddf5) after a three-round review cycle: independent second review REVISE (3 merge-blocking findings, incl. a falsified security claim in the migration) → full revision → delta re-review APPROVE WITH FOLLOW-UPS → final hardening delta (SECURITY DEFINER pg_temp pin, roles-aware owner-exemption assertion).
- FAD-11 (three SPEC-01 escalation rulings: revoked membership → 404 with T-02b added; EX-2 org-scoped DML; capability gate above SQL until M1-002) and FAD-12 (authorization + mutation share one unit of work on every surface) recorded; SPEC-01 §7.1/§4.3 amended with dated notes.
- EV-M0-SPA qualified (embedded-postgres exit-code masking — per-test log unaffected); root eslint now ignores `.worktrees/**` (gate race found during verification); standing merge-discipline note added to the runbook.
- SP-E UX brief + design tokens authored (docs/fable/28) — carried M0 item discharged.
- OPUS-M1-002 and OPUS-M1-003 issued in parallel worktrees; EV-M1-TENANCY residuals 1–7 recorded as M1-002 entry conditions. M2 NOT authorized.

## 2026-08-02 — M0 acceptance review (owner-directed; Fable)
- All exit-report claims independently re-verified against the repository: isolation harness re-run 36/36 (fresh install), CI gates 12/12, red cases 14/14, solver harness H-0..H-8 re-run 0 failed with every load-bearing finding reproduced (H-6 nondeterminism, H-5 SIGKILL cleanliness, H-8 assumption-core cost). docs/fable/26-m0-acceptance-addendum.md.
- One defect found and fixed at acceptance: secret-scan gate walked Python virtualenvs (`.venv` missing from the shared skip list) — false-positive red gate for any developer following the spike README. Fixed in scripts/gates/lib/gate.mjs; red-case battery re-proven 14/14 after the fix. Nothing weakened.
- First three M1 packets finalized in runbook format — docs/fable/27-m1-task-packets.md, marked NOT ISSUED; plan validator extended (+7 assertions, now 36) to guard against silent issuance.
- M0 exit criteria confirmed PASSED (carried items unchanged). M1 recommended, NOT begun.

## 2026-08-01 — Independent planning mandate (Fable)
- Full audit of research corpus (retained, authoritative) and remediated architecture (retained as PROPOSED, re-review required); findings F-01..F-11.
- Created docs/fable/00–20: assessment, audits, product spec, parity matrix (58 rows), workflow catalogue, roles model, domain/state-machine ratifications, architecture adoption with conditions, engine + picklist plans, security and testing strategies, **implementation roadmap M0–M12**, Opus runbook, risk additions NR-1..8, decision register, recommendation with first task packet OPUS-M0-001.
- Created control documents (this directory).
- No application code. No source research. No gate claimed.

## 2026-08-01 (later) — Expanded decision authority mandate (Fable)
- All formerly-blocking decisions resolved under delegated authority: FD-1..4, 20 product decisions, TDG-01..15 technology selections, OI-1..7 / EV-1..8 / LEGAL-1 provisional defaults — docs/fable/21-decision-resolution.md.
- Internal adversarial verification review of the highest-risk remediations commissioned (Opus sub-agent); external re-review remains REQUIRED, repositioned to block beta entry rather than M1 (corrected per internal-verification finding V-04).
- Corpus corrections applied with dated history: CAR-026 count fix (report 18 + remediation record), F-05 stale checkout-context sentence (arch doc 02), banner amendments on the pending-decision registers (report 24 §6, arch 19 §2.2/§3).
- New: 22-readiness-assessment, 23-opus-task-packets (three approved packets, not executed), 24-execution-standards (branch/worktree strategy, quality gates, authorization prompt); roadmap amended (M1 gate, §6a compact sequence); plan validator added (docs/fable/validate.py).
- Implementation still not started; no gate passed; no SBX test executed.

## 2026-08-01 (final) — Internal verification incorporated; plan declared ready
- Internal adversarial verification returned VERIFIED WITH CORRECTIONS NEEDED (29 findings: 16 High, 10 Medium, 3 Low, incl. 5 governance findings against this mandate's own process — all accepted).
- All findings dispositioned in docs/architecture/remediation/internal-verification-corrections.md; five new design decisions (FD-5..FD-9: daily_assignments for picklist selections, keyed-HMAC reference pseudonymization, signed vocabulary snapshots, current_published_assignments for D-1b, vacation as a true subtype); 21 architecture files amended with dated markers.
- External re-review corrected from "advisory" back to REQUIRED, blocking controlled-beta entry (V-04); "the architecture is proposed, not approved" restored.
- Architecture validator strengthened to 95 assertions (absence-assertions 48c/50d/55a-e per the review's meta-finding). All three validators green.
- 22-readiness-assessment.md finalized. Frozen-checkpoint rule adopted (V-01): no amendments while a commissioned review is open.

## 2026-08-01 (M0) — OPUS-M0-001 accepted; session-limit recovery
- Recovery: prior session died mid-revision (uncommitted worktree changes). Assessment: revision complete and trustworthy after independent verification; committed and squash-merged (ea77ac5).
- OPUS-M0-001 ACCEPTED: 36/36 isolation harness, TDG-02/03 confirmed (in-process scope), second review blocking findings fixed. Evidence: docs/evidence/EV-M0-SPA.
- SPEC-01 §4 amended from executed evidence (FAD-9): nullif predicate, all-four read-back, composite tenant FKs, existence-oracle mitigation, startup pooler assertion.
- OPUS-M0-002 and OPUS-M0-003 issued in parallel worktrees.

## 2026-08-01 (M0 close) — Milestone M0 complete
- All three tasks ACCEPTED and squash-merged (ea77ac5, 2880bd2, 8dad022) with evidence filed (EV-M0-SPA/SCAFFOLD/SPC); interruption recovery performed and documented; independent second review on the critical task; one plan-contradicting spike finding handled per protocol (FAD-10, SPEC-04 amended).
- TDG-01/02/03(scoped)/11(scoped)/14 confirmed; TDG-04 carried to OPUS-M1-003; SP-E UX brief carried to M1 entry.
- Exit report: docs/fable/25-m0-exit-report.md. All validators green (95/95, 29/29, research PASS) + CI 12/12 on main. M1 NOT authorized.

## 2026-08-01 (M0 final checkpoint) — Control-document reconciliation
- Owner-directed sweep of all living control documents before closing M0. Updated: PROJECT-STATUS (stale phase line), EVIDENCE-INDEX (three M0 evidence rows replacing 'none yet'), ASSUMPTIONS (FA-3 largely discharged), RISK-REGISTER (NR-4/NR-1 reconciliation), CHANGELOG (this entry). Verified current, no change warranted: ARCHITECTURE-DECISIONS (FAD-1..10 complete), PRODUCT-DECISIONS (no product decision changed in M0), TEST-TRACEABILITY (M0 rows already PASSED+evidence), IMPLEMENTATION-ROADMAP (M0 complete / M1 not authorized), OPUS-AGENT-RUNBOOK log, OPEN-QUESTIONS, ORCHESTRATION, FEATURE-PARITY-MATRIX pointer (no capability reached implemented/verified in M0 — spikes and scaffold only).
- Exit report §12 added: per-document disposition. All validators green. M1 NOT authorized.
