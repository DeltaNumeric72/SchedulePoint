# IMPLEMENTATION-ROADMAP (pointer + status)

Roadmap: [../16-implementation-roadmap.md](../16-implementation-roadmap.md) (amended 2026-08-01; compact sequence in its §6a).

| Milestone | Status |
|---|---|
| M0 Prove | **COMPLETE 2026-08-01** (exit report [../25-m0-exit-report.md](../25-m0-exit-report.md); two carried items -> M1 entry) |
| M1 Kernel | **COMPLETE 2026-08-03** (exit report [../29-m1-exit-report.md](../29-m1-exit-report.md)); 4/4 tasks accepted (001 tenancy · 002 authorization · 003 audit+outbox · 004 integration, added under FAD-13); tenancy, authorization and audit kernels are on main |
| M2 Catalogue+structure | **COMPLETE 2026-08-04** (exit report [../31-m2-exit-report.md](../31-m2-exit-report.md)); 4/4 accepted (001 SBX/fixtures/MULTI · 002 catalogue+first UI · 003 profiles/qualifications · 004 integration). **Honest scope note:** roadmap-M2's rule-authoring/AST, B-\* corpus, full group settings, and site attribute were NOT in the authorized packets — carried explicitly (exit report §Carried) |
| M3 Manual schedule → published version | **COMPLETE 2026-08-05** (exit report [../33-m3-exit-report.md](../33-m3-exit-report.md)); **8/8 tasks accepted** (001 authn · 002 rules · 003 publication core · 004 authoring UX · 005 publication UX · 006 staff views · 007 settings/site · 008 integration). V-01..V-19 green, SBX-018 filed, QA-SCH executed, step-06 live (6/24 kinds, FAD-27 fail-closed). **Honest scope notes:** settings-page consolidation carried (disclosed); SPEC-14 M-cells unclaimed pending EV-8 (M6); 24 rule kinds await evaluation semantics rulings (11 one-ruling-away, M4) |
| M4 Automated scheduling | **IN PROGRESS — authorized 2026-08-07** against `7b579f2` (tag `milestone/M3`; entry record doc 34). M4-000 COMPLETE 2026-08-12 (000A `94af3c5` · 000B `a614f7e` · 000C `323d576`); M4-001 `b1aa64e` · M4-001R `efa1ffd` · M4-001S `d910af6` (migration 0017) · M4-002 `5e0ac4e` (E1 engine) · **M4-003 ACCEPTED & MERGED 2026-08-16 (`8deb4c5`, migration 0018) — the 16-state lifecycle, fenced claims, validation-gated candidates, scheduler UI, raw-NUL gate.** Next: M4-004 (E2 optimization/quality/explanations) → M4-005 (integration/recovery/close). M3R remains PAUSED; stops before M5. *(Row corrected 2026-08-13 — it had never been updated for the M4 authorization.)* |
| M5..M12 | not started; **M5 NOT authorized** |
