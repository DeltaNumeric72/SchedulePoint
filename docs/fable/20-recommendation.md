# 20 — Recommendation

**Summary judgement of the independent orchestrator, and the exact first implementation task.**

> **AMENDED 2026-08-01.** The owner actions requested in §3 were subsequently delegated to the orchestrator and are resolved in [21-decision-resolution.md](21-decision-resolution.md). The OPUS-M0-001 packet below remains the first task, now finalized (with two more) in [23-opus-task-packets.md](23-opus-task-packets.md); execution awaits only the authorization prompt in [24-execution-standards.md](24-execution-standards.md) §G.

---

## 1. The recommendation in five sentences

The research corpus is authoritative and complete for its purpose; no further source research is possible or needed. The remediated architecture is the right design — I evaluated it from first principles and would have built substantially the same system — but it is remediated-unverified, so the independent re-review must be commissioned now and must gate schema freeze. The project's missing layer was execution: this package supplies the roadmap (13 milestones, four stages, all 58 capabilities, vertical slices with proof obligations), the parity framework, and the Fable→Opus runbook. Implementation should begin immediately with Milestone 0 — technology-gate spikes and scaffold — which is safe under any re-review outcome and converts the plan's biggest unknowns into evidence within the first tasks. Everything beyond M0 waits on the re-review verdict and your ratifications in [19-decisions-needed.md](19-decisions-needed.md) §1.

## 2. What I did with my authority

Exercised: full corpus audit (with findings F-01..F-11, including one live documentation defect, F-05); independent re-derivation of the architecture trade-offs; two decisions of my own within the proposal's intent (single repository with workspaces; entitlements-as-feature-flags with no runtime flag service); a normalized role model that refuses to ship untestable distinctions; the complete roadmap, parity framework, runbook, risk additions (NR-1..8), and control-document set. Deliberately **not** exercised: re-opening any approved decision (PO-DEC-00/02/04/08/18 all stand); replacing research or architecture documents that survive audit; performing source research; starting implementation; approving my own remediation spot-checks as a substitute for the independent re-review.

## 3. Immediate next actions

| # | Action | Owner |
|---|---|---|
| 1 | Ratify D-A..D-D ([19](19-decisions-needed.md) §1) | You |
| 2 | Commission the independent re-review (parallel to M0) | You (I draft the review brief on approval) |
| 3 | Issue OPUS-M0-001 (§4 below), then the remaining M0 packets (SP-B..SP-E, scaffold) | Me |
| 4 | Early-ratify PO-DEC-09/12/13/23; re-adopt the other 15 defaults | You |
| 5 | Start EV-1 vendor-spec requests and OI-3/4 provider/residency deliberation (long lead) | You |
| 6 | Apply the F-05 doc-02 correction and the authorized CAR-026 count fix | Me |

## 4. OPUS-M0-001 — the first task packet

```markdown
# TASK: OPUS-M0-001 — Tenant-isolation unit-of-work spike (TDG-02/03 + SPEC-01 harness)
Milestone / Slice:   M0 / SP-A
Objective:           Prove in runnable code that the recommended data layer and pooling
                     mode can implement SPEC-01's transaction-local tenant isolation.
User outcome:        None (spike). Output is evidence that either validates or changes
                     the data-layer decision before anything is built on it.
Read first:          docs/architecture/specs/SPEC-01 (all); ADR-0003; ADR-0022;
                     docs/architecture/02-technology-stack.md §3.2 NOTING its §3.2
                     checkout-context sentence is superseded by SPEC-01 §4 (finding F-05);
                     SPEC-15 TDG-02/TDG-03.
Allowed paths:       spikes/sp-a-isolation/** (new, throwaway-quality but honest)
Prohibited paths:    everything else; NO research reports; no docs edits.
Required behaviour:  A minimal PostgreSQL schema: two organizations, one tenant table
                     with an RLS policy reading set_config-based context; five DB roles
                     per SPEC-01 §4 (app role: non-owner, no BYPASSRLS, FORCE RLS on
                     tables). A unit-of-work wrapper that BEGINs, set_config(..., true),
                     reads the context back, and ends with the transaction. Candidate
                     data-layer libraries (per TDG-02 shortlist) exercised through it.
Authorization:       n/a (spike) — but every probe asserts zero cross-tenant rows.
Data:                Must demonstrate: exclusion constraint, partial unique index, and a
                     trigger expressible through the chosen migration path (TDG-02).
Tests required:      SPEC-01 §7.2 T-07..T-15 implemented as an automated harness, plus:
                     forced exception mid-transaction; query cancellation; pool timeout
                     and reuse across orgs; nested transaction; statement outside the
                     wrapper (must see zero rows and fail writes); worker-role probe;
                     transaction-level pooling verified, statement-level pooling shown
                     to break (TDG-03 evidence); continuous cross-tenant probe during a
                     two-org concurrency storm.
Commands to run:     docker compose up (PG); harness run command; full output captured.
Acceptance criteria: All T-07..T-15 pass; any wrong-tenant row anywhere = task failure;
                     a written spike report: library verdict per TDG-02 criteria, pooling
                     configuration verdict per TDG-03, sharp edges found, recommendation.
Deliverables:        spikes/sp-a-isolation/ code + harness + captured output +
                     SPIKE-REPORT.md (this becomes evidence artifact docs/evidence/EV-M0-SPA).
Escalate if:         no candidate library can issue SET LOCAL in a caller-controlled
                     transaction cleanly; RLS behaviour contradicts SPEC-01 §4; or the
                     harness cannot force pool reuse deterministically.
```

**Why this first:** it is the mechanism every tenant-scoped feature in all twelve subsequent milestones sits on, it was the subject of a Critical review finding (CAR-002), and it is the cheapest point at which a wrong technology choice can still be reversed for free.

## 5. Closing statement

Nothing in this package is implementation, verification, or a passed gate. The corpus's honesty discipline — unresolved stays unresolved, claims carry evidence, differences carry reasons — is the project's most valuable asset, and this plan is built to preserve it while finally converting three months of disciplined observation and design into a working product, one proven vertical slice at a time.
