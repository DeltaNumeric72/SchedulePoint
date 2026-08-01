# CHANGELOG

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
