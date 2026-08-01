# 00 — Executive Assessment

**Author:** Claude Fable 5, acting as independent chief product, research, architecture, and engineering orchestrator.
**Date:** 2026-08-01.
**Mandate:** independently assess the entire SchedulePoint project and produce a comprehensive development plan. Reject, replace, or reuse existing material on merit only.
**Status of this package:** planning deliverable set. **No application code was written. No source-site research was performed. No gate is claimed passed.**

---

## 1. Verdict on the existing work

**Retain the research corpus as authoritative. Retain the remediated architecture as the working proposal, conditional on an independent re-review. Replace nothing wholesale. The project's real gap is not quality — it is that the plan stops at architecture.**

I reviewed all 25 research reports plus four maintained indexes, the 19 architecture documents, 23 ADRs, 16 normative SPECs, the independent Codex review (27 findings, `REDESIGN REQUIRED`), the Phase 14 remediation record, both validators (both pass: research validation clean; architecture validator 90/90 assertions), and the workflow playbook. I spot-checked remediation claims against the actual SPEC files (SPEC-01 request context, SPEC-02 picklist turn transaction) and confirmed the claimed design changes exist in substance, not just in the remediation record's prose.

This corpus is unusually disciplined. Specifically:

- **Evidence classification is honest and consistently enforced.** OBSERVED / INFERRED / UNRESOLVED labels survive all the way from phase reports into the capability baseline; 11 of 21 state machines carry Low confidence rather than invented transitions; the source's picklist execution — the product's signature feature — is explicitly marked never-observed.
- **The clean-room boundary held.** One safety incident (Phase 8 "Add Room") is documented in full rather than minimised, and produced both a product finding (FEAT-048) and a hardened boundary. No credential, token, patient datum, or personal identifier appears in any artifact I sampled.
- **The independent review worked as designed.** Codex found four Critical defects (session-global tenant context, RLS session-variable pooling reuse, non-atomic picklist turn, unprovable ingestion privacy) that the original architecture genuinely had. The remediation addresses all four with verifiable design mechanisms (immutable request context tuples, transaction-local `SET LOCAL` in a mandatory unit-of-work, `UNIQUE (turn_id) WHERE accepted`, the raw-ingress enclave) and — correctly — does not self-approve.

**What is missing is the entire execution layer.** There is no implementation roadmap. No vertical-slice backlog. No sub-agent delegation protocol (the drafts in `docs/architecture/drafts/` are explicitly not installed). No UX brief. No project-control documents. No decision has been made about how the 15 open technology gates (TDG-01..15) get closed, in what order, or by whom. The playbook envisions this as its Phase 18, and Phase 18 has not happened. **This deliverable set supplies that layer.**

## 2. The ten questions the mandate requires me to answer

### 2.1 Should the existing plan be retained, revised substantially, or replaced?

**Retained with substantial additions, plus targeted corrections.**

- **Research (reports 01–24, indexes): RETAIN as authoritative.** Report 19 remains the scope authority; report 20 the contradiction authority; report 24 the gate authority. One authorized correction is needed (report 18's "36 tests" prose vs. 39 actual — CAR-026, blocked only on your authorization).
- **Architecture (19 docs, 23 ADRs, 16 SPECs): RETAIN as the working proposal.** I independently examined the four Critical remediations and consider the mechanisms sound. But the remediation is correct that it cannot self-approve: **an independent re-review is a precondition to schema freeze**, and I have kept it as a blocking condition rather than substituting my own endorsement for it.
- **Plan (sequencing, execution, delegation): DID NOT EXIST — created here.** [16-implementation-roadmap.md](16-implementation-roadmap.md) and [17-opus-agent-runbook.md](17-opus-agent-runbook.md) are new work, not revisions.
- **Corrections I direct** (detailed in [01](01-existing-materials-audit.md) §4): the roadmap must front-load the technology-decision spikes (SP-1..SP-10) and the three schema-stage proof harnesses (SPEC-01 T-tests, SPEC-02 P-tests, SPEC-05 V-tests) that the remediation scheduled "at the schema/prototype stage" — the existing corpus names them but nothing sequences them; the playbook's Phase 18 deferral list ("defer … documents, and full picklist automation") contradicts report 19's production dispositions and must not be followed as written; and the drafts/CLAUDE.md + AGENTS.md need adversarial linting and installation before any implementation task runs.

### 2.2 Was additional iSchedule.md research necessary?

**No. I performed none, deliberately.** Full reasoning in [04-research-decision.md](04-research-decision.md). In short: the coverage audit passed with no missing top-level module; all 14 remaining evidence gaps are either (a) unobtainable read-only (live picklist execution, form validation, build execution, lower-role sessions — every one requires a mutating action or credentials the research policy prohibits), or (b) already carried as named SchedulePoint sandbox tests. Re-crawling would add risk (the live production picklist is still active in one group) and no decision-changing evidence. The research corpus's own declaration — broad research permanently closed — is correct and I ratify it.

### 2.3 What major gaps were found?

Ranked (full list in [03-contradictions-and-gaps.md](03-contradictions-and-gaps.md)):

1. **No implementation roadmap or backlog** — the plan ends at architecture. *(Closed by deliverable 16.)*
2. **No sub-agent execution protocol** — nothing governs how implementation work is packaged, reviewed, or accepted. *(Closed by deliverable 17.)*
3. **Independent re-review not yet commissioned** — the architecture is remediated but unverified; every schema decision inherits that risk.
4. **All 15 technology gates open, zero spikes run** — the web framework, data layer, pooling mode, job queue, report renderer, and component library are all undecided; three of them (TDG-02, TDG-03, TDG-14) carry correctness (not preference) requirements.
5. **No UX/design brief** — playbook Phase 19 not started; the accessibility acceptance matrix (SPEC-14) has no component system to bind to.
6. **Owner inputs OI-1..7 and evidence dependencies EV-1..8 unassigned** — RPO/RTO, provider, region, residency, vendor specs, AT lab; several gate G-BETA/G-PROD items.
7. **Live picklist behaviour remains a designed-not-observed subsystem** — mitigated by SPEC-02's from-first-principles design and nine dedicated sandbox tests, but it is the highest product-risk area and the roadmap sequences it accordingly (after LIVE-SIM exists).
8. **No incident-response plan, no runbooks, no processor register** — named in the corpus as missing; still missing; owned in the roadmap.

### 2.4 What architecture do I recommend?

**Adopt the remediated proposal:** modular monolith (19 modules, 6 layers) · six process classes in three images (Node.js/TypeScript app; Python OR-Tools CP-SAT solver worker; minimal raw-ingress enclave) · PostgreSQL with transaction-local RLS as defence-in-depth under an application authorization evaluator · immutable versioned schedule publication enforced by database triggers · transactional outbox · server-authoritative WebSocket picklist coordination with database-decided races · append-only hash-chained audit (A1 → A2).

I evaluated this independently against alternatives ([11-architecture.md](11-architecture.md) §2) and would have designed substantially the same system. My conditions of adoption: (1) independent re-review before schema freeze; (2) TDG-01..04 closed by spike before any persistent code; (3) the three schema-stage proof harnesses pass before feature work builds on their tables.

### 2.5 How close will SchedulePoint be to iSchedule.md?

**High functional parity across all 58 capabilities; deliberate divergence in mechanism where the source is defective or unsafe.** Every observed user outcome is preserved (report 19's discipline, which I ratify). The product will feel equivalent in: scheduling model (shift types, groups, FTE, rules), the three schedule views with independent assignment/credit editing and per-cell provenance, request/vacation lifecycles including advisory-not-blocking over-quota, opportunities and swaps, the turn-based picklist with four-channel escalation and proxies, reports, contacts, documents, and calendar feeds. See [06-feature-parity-matrix.md](06-feature-parity-matrix.md).

### 2.6 Which differences are intentional?

**Every difference is classified; none is accidental** ([06](06-feature-parity-matrix.md) §3). The principal intentional divergences: the six source defects are closed (no third-party avatar identifier leak, no request amplification, no instant-commit Add, no delete-on-inspect, accessibility baseline met, no silently broken support widget); versioned/revertible publication where the source has no rollback; a notification delivery log where the source has none; an idempotent reversible vacation commit replacing the irreversible transfer mechanism (outcome kept, mechanism replaced); role+grant authorization replacing the vestigial flag model (C-02 resolution); patient-identifying data excluded by the ingestion boundary; timezone-aware ISO-8601 dates replacing the source's timezone-naive three-format mix; and MFA/SSO closing an observed auth gap.

### 2.7 What implementation order do I recommend?

Twelve milestones in four stages ([16-implementation-roadmap.md](16-implementation-roadmap.md)): **Stage 0 — Prove** (M0 spikes/TDG closure + scaffold; M1 tenancy/identity/audit kernel with the three proof harnesses passing); **Stage A — Schedule** (M2 shift catalogue + rules authoring; M3 manual scheduling + versioned publication; M4 solver integration + explainability; M5 requests/vacation; M6 fairness/statistics + schedule views complete = internal alpha); **Stage B — Coordinate** (M7 notification platform; M8 marketplace: opportunities/swaps/transfers; M9 picklist preparation + LIVE-SIM environment; M10 picklist execution/real-time = controlled beta entry); **Stage C — Harden** (M11 reports/documents/calendar/integration framework; M12 production hardening: A2 audit, DR rehearsal, security review). Every milestone is a set of user-outcome vertical slices with entry/exit criteria — no "build backend" milestones exist.

### 2.8 Which decisions require your approval?

Enumerated with recommendations in [19-decisions-needed.md](19-decisions-needed.md). The blocking set: **(a)** ratify this roadmap and the parity framework; **(b)** commission the independent re-review; **(c)** authorize the CAR-026 report-18 count correction; **(d)** ratify — or explicitly accept as working defaults — the 19 pending product decisions, of which **PO-DEC-09 (MFA/SSO), PO-DEC-12 (qualifications), PO-DEC-13 (conflict taxonomy), and PO-DEC-23 (solver targets)** are the four whose late reversal is costliest; **(e)** provide owner inputs OI-1..7 (RPO/RTO, provider, region, residency, support model); **(f)** begin procurement on EV-1..8. Items (a)–(c) block the first Opus task; (d)–(f) block later milestones, not M0.

### 2.9 Is the project ready to begin Opus implementation?

**Conditionally — yes for Milestone 0, no for anything beyond it.** M0 (spikes + scaffold) is deliberately designed to be safe to start now: it implements no product feature, builds throwaway-or-foundation code only, closes the technology gates the architecture depends on, and produces the proof harnesses the re-review will want to see. Feature implementation (M1 onward) must wait for the re-review verdict and your ratifications in §2.8(a)–(c). Starting M0 in parallel with the re-review is the highest-value use of the next two weeks.

### 2.10 The exact first Opus task packet

**OPUS-M0-001 — "Tenant-isolation unit-of-work spike (TDG-02/TDG-03 closure + SPEC-01 proof harness)."** Full packet in [20-recommendation.md](20-recommendation.md) §4 and [17-opus-agent-runbook.md](17-opus-agent-runbook.md) §9. It is the single most load-bearing unknown in the entire design: prove, in runnable code with PostgreSQL, that the chosen data layer reliably issues `SET LOCAL` inside a caller-controlled transaction, that tenant tables fail closed outside the unit of work, and that pool cancellation/reuse cannot leak context — executing SPEC-01's T-07..T-15 plus a two-organization concurrency probe. If that spike fails, the data-layer choice changes before anything is built on it. If it passes, the foundation of every subsequent milestone is proven rather than assumed.

---

## 3. How to read this package

| Read | If you want |
|---|---|
| This document + [20-recommendation.md](20-recommendation.md) | The decision summary |
| [16-implementation-roadmap.md](16-implementation-roadmap.md) | What gets built, in what order, with what proof |
| [19-decisions-needed.md](19-decisions-needed.md) | What only you can decide |
| [01](01-existing-materials-audit.md)–[04](04-research-decision.md) | Why I trust (and where I correct) the existing corpus |
| [05](05-independent-product-specification.md)–[10](10-state-machines.md) | The product model |
| [11](11-architecture.md)–[15](15-testing-strategy.md) | The technical plan |
| [17-opus-agent-runbook.md](17-opus-agent-runbook.md) | How implementation will actually be delegated and reviewed |
