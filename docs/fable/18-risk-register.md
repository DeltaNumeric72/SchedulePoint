# 18 — Risk Register

**I ratify the architecture risk register (doc 19 §1: RISK-01..31) as scored** — likelihood/impact judgements there survive my review, and each already names a mitigation and a retiring test. This document does not restate those 31 rows; it (a) records where the roadmap changes a risk's timeline, and (b) adds the risks my audit found that the corpus does not carry. Live tracking: [control/RISK-REGISTER.md](control/RISK-REGISTER.md), seeded from both sets.

## 1. Roadmap effects on existing risks

| Risk | Effect |
|---|---|
| RISK-01/02 (solver quality/explanations) | Retirement pulled earlier: E0 spike in M0, corpus at M2, bands at M6 — instead of "before some later gate" |
| RISK-05/16 (picklist concurrency/never-observed) | P-01..15 run from the first execution commit (M10 entry), LIVE-SIM built one milestone earlier (M9) |
| RISK-11 (cross-tenant) | SPEC-01 harness is the literal first Opus task; MULTI env at M1 |
| RISK-15/24 (no IR plan / no runbooks) | Owned: IR plan M11, tabletop M12, runbooks M11–M12 |
| RISK-19 (defaults reversed late) | [19-decisions-needed.md](19-decisions-needed.md) asks for early ratification of the four costliest (PO-DEC-09/12/13/23) |
| RISK-21 (58-capability overwhelm) | Roadmap rules R-2/R-4: sequencing may move, scope and tests may not |
| RISK-22 (no independent review of current architecture) | Re-review commissioned at M0, gates M1 schema freeze |
| RISK-23 (backups unproven) | SBX-035 pinned to M12 exit, needs EV-5/6 by then |
| RISK-30 (free-text removal rejected) | Fast vocabulary-add path is an M9 slice, tested with scheduler-shaped fixtures before beta |
| RISK-31 (audit chain throughput) | Benchmark pinned to M12 (measured before G-BETA claim per ADR-0019 — scheduled with margin) |

## 2. New risks (my audit)

| ID | Risk | L | I | Mitigation | Retired by |
|---|---|---|---|---|---|
| **NR-1** | **Single-orchestrator context loss:** this project's control state lives in one long-running orchestration; a lost or degraded session mis-sequences work or re-litigates settled decisions | med | med | The [control/](control/) documents are the externalised state: PROJECT-STATUS, decisions, roadmap statuses updated at every acceptance — any fresh session reconstructs from files, not memory | Standing discipline; checked at every milestone review |
| **NR-2** | **Documentation drift between the fable layer, the architecture package, and the research corpus** as implementation discovers reality | med | med | One-way precedence declared (research evidence ← architecture SPECs ← fable plan ← control status); deviations recorded as decisions, never silent edits; validators extended to cross-check fable-layer references | Validator extension at M1 |
| **NR-3** | **Stale doc-02 checkout-context sentence re-introduces the CAR-002 defect** if an implementer reads doc 02 §3.2 instead of SPEC-01 | low | high | Fix the sentence (finding F-05) in the next architecture edit; runbook packets always cite SPEC-01 directly for persistence work | The edit itself |
| **NR-4** | **Sub-agent quality variance:** implementation defects that survive one review | med | high | Runbook §6 re-run-don't-trust + independent Opus review for critical classes + invariant harnesses in CI catching what review misses | Ongoing; measured by defect-escape rate at milestone reviews |
| **NR-5** | **Re-review returns REDESIGN again**, invalidating M1 schema work started in parallel | low | high | M0 contains no schema commitment; M1 begins schema work only against SPECs the re-review is examining, freeze deferred until verdict; worst case is bounded rework of one milestone | Re-review verdict |
| **NR-6** | **Playbook/process documents drift from this mandate** (e.g. Phase-18 deferral list) and get pasted as prompts later | med | med | [01](01-existing-materials-audit.md) §3 marks the playbook historical; control docs are the live process authority | Standing |
| **NR-7** | **Estimate vacuum misread as open-ended timeline** by stakeholders | med | low | Roadmap §6: rolling forecast from measured throughput after M1 | First forecast at M1 review |
| **NR-8** | **Benchmark-band circularity:** bands defined from our own corpus runs (E3) could be set to whatever we achieve | low | med | Bands proposed at M6 are ratified by you against report 21 §8.3's conservative targets (PO-DEC-23), not self-approved | PO-DEC-23 ratification |

## 3. Standing risk-review cadence

Risk register reviewed at every milestone exit (checklist item 7); any risk whose retiring test failed is re-scored and reported in PROJECT-STATUS; new risks enter via control register with an owner and a retiring condition — a risk without a retirement path is a decision request, not a register row.
