# 11 — Architecture

**My independent architecture decision: adopt the remediated proposal, with three binding conditions.** I evaluated it from first principles against the mandate's Stage-7 checklist rather than inheriting it, and this document records that evaluation, the adopted shape, and the conditions. Normative detail remains in `docs/architecture/` (19 docs, 23 ADRs, 16 SPECs) — this document governs *whether and how* that package is used.

---

## 1. The adopted shape (one page)

- **Topology:** modular monolith — 19 domain modules in 6 layers, prohibited-dependency table CI-enforced; six process classes in **three images**: `app` (Node.js LTS + TypeScript: web/API, workers, real-time coordinator, migration runner), `solver` (Python + OR-Tools CP-SAT — no official Node binding exists, S-04), `ingress` (minimal raw-payload enclave with no logging/persistence/DB credential).
- **Data:** PostgreSQL as system of record — a stated deep commitment with no replacement boundary. Tenant isolation = application evaluator (primary) + transaction-local RLS (defence in depth) inside a mandatory unit-of-work; fail-closed outside it; five database roles; statement-level pooling prohibited.
- **Domain safety in the database:** business invariants as constraints (D-1..D-25) — version-scoped exclusion constraints, one-accepted-selection-per-turn, publication immutability triggers, gapless event sequences, idempotency keys.
- **Async:** PostgreSQL-backed durable job queue (transactional enqueue = the outbox property, I-11); broker only when depth metrics justify.
- **Real-time:** WebSocket, server-authoritative, page-scoped; coordinators relay a durable ordered event log and never generate events; leases + fencing tokens.
- **Cross-module writes:** three write classes (own-aggregate / in-transaction domain port / post-commit outbox); one owning module and one commit point per workflow (I-22).
- **Identity/authz:** first-party auth + MFA, per-org OIDC; four-layer capability model with one pure evaluator (SPEC-06).
- **Delivery:** provider ports (email/SMS/voice/push) behind a four-concept notification model; at-least-once external delivery honestly stated (I-20).
- **Storage/reports:** S3-compatible object store, signed URLs, snapshot-bound async report artifacts.
- **Audit/observability:** append-only hash-chained audit (A1→A2), OpenTelemetry, allowlist structured logging, requests-per-interaction budget metric.
- **Deployment:** managed container platform + managed PostgreSQL (sync standby, second zone) + managed object store + secret store; expand/migrate/contract migrations; provider/region/residency = owner input (OI-1..7), deliberately undecided rather than wrongly decided.

## 2. Independent evaluation against alternatives

I re-ran the major trade-offs rather than accepting them:

| Decision point | Alternatives I weighed | My conclusion |
|---|---|---|
| Monolith vs services | Single-process; modular monolith + workers; 5–8 services; microservices | **Modular monolith + dedicated processes is right.** The publication→notification→audit path is a database transaction here and a saga anywhere else; a pre-revenue team cannot pay distributed-systems tax. The extraction boundaries (solver and coordinator already separate) are the correct hedge. Concur with ADR-0001 |
| Runtime | Single-language dream vs Node+Python | Forced by fact S-04; the honest cost accounting (RISK-29: permanent second SBOM/patch stream) is correct. Concur with ADR-0020 |
| PostgreSQL + RLS | App-only scoping; schema-per-tenant; DB-per-tenant | Shared-schema + RLS-as-second-layer is the right cost/assurance point at this scale; schema-per-tenant complicates migrations 100×; app-only scoping failed the review once already (CAR-002 class of bug). Concur with ADR-0003 **as remediated** (transaction-local only) |
| Solver | CP-SAT vs MIP vs heuristic vs hybrid | CP-SAT is correct because two production requirements decide it: provable hard-constraint satisfaction and first-class infeasibility. Heuristics cannot prove either. Hybrid remains the stated evolution. Concur with ADR-0006 |
| Real-time | WebSocket push vs SSE vs polling | Approved (PO-DEC-18); the *architecturally decisive* part is not the transport but the durable-log-plus-relay design — transport is swappable, event authority is not. Concur |
| Queue | PG-backed vs Redis vs managed broker | Transactional enqueue is worth more than throughput headroom now; reversible. Concur |
| API | REST+typed contracts vs GraphQL | GraphQL's field-level deny-by-default across four authz layers is a real hazard; caution justified. Concur |
| **Where I'd have differed** | — | Marginal only: I'd consider SSE for the *monitor* dashboard (read-only) to cut socket surface — noted as an option in M10, not a change; and I flag the framework/data-layer gates (TDG-01/02) as the two most schedule-critical unknowns, hence their place in M0 |

**Simplicity check (mandate: prefer the simplest architecture that reliably supports the confirmed product):** the three-image split, the enclave, and the coordinator process are each justified by a named failure class (S-04; CAR-004; CAR-003/RISK-04), not by taste. Nothing else is separate. No microservices. This passes.

## 3. The three binding conditions of adoption

> **AMENDED 2026-08-01 ([21-decision-resolution.md](21-decision-resolution.md) FD-2, §3):** condition 1 is now satisfied by the **internal adversarial verification review** (findings dispositioned before M1 schema freeze), with the **external** re-review REQUIRED and blocking for controlled-beta entry (M10 exit; V-04) — the architecture remains `PROPOSED` until it upgrades the verdict. Conditions 2–3 stand unchanged; the TDG gates now carry decided selections whose M0 spikes are confirmations.

1. **Independent verification before schema freeze.** *(As amended above.)* Internal adversarial verification of CAR-001/002/003/004/007/008/011 against their SPECs, commissioned 2026-08-01; its findings must be dispositioned before feature milestones build on the schema. External re-review: required, blocking beta entry (V-04).
2. **TDG-01..04 confirmed by executed spikes before persistent code.** Data layer (`SET LOCAL` in caller-controlled transactions + exclusion constraints + partial unique indexes + triggers); pooling mode (transaction-level, never statement-level); web framework; job-queue leases. M0 exists to confirm these. A gate closed without its spike is reopened (SPEC-15 standing rule — ratified).
3. **The three proof harnesses pass at the schema stage:** SPEC-01 T-07..T-15 (isolation under pool abuse), SPEC-02 P-01..P-15 (turn atomicity, ≥50-trial races), SPEC-05 V-01..V-16 (publication immutability and cloning). These run in M0–M1/M3 *before* the features that depend on them, not as later QA.

## 4. Corrections to carry into the architecture package

- **F-05:** doc 02 §3.2's withdrawn "set on every connection checkout" sentence — **corrected 2026-08-01**; the internal verification's cross-document sweep then found and corrected twelve further stale statements (see [docs/architecture/remediation/internal-verification-corrections.md](../architecture/remediation/internal-verification-corrections.md) §2).
- Keep `docs/architecture/` status `PROPOSED` until re-review; ADR acceptance happens per-ADR at re-review, not en bloc.
- The drafts (CLAUDE.md/AGENTS.md) remain uninstalled; their content is absorbed and superseded for delegation purposes by [17-opus-agent-runbook.md](17-opus-agent-runbook.md), which will generate the installed versions at M0.

## 5. Mandate checklist coverage

Monolith/modular ✓ (§2) · monorepo: **one repository, pnpm workspaces + `solver/` Python package** — single versioning of contracts outweighs polyglot-repo purity (my decision; ADR-worthy at M0) · frontend ✓ TDG-01/14 gated, server-rendered + islands posture (02 §2.3) · backend ✓ · PostgreSQL/ORM ✓ TDG-02 · auth provider ✓ (first-party + OIDC; provider choice TDG-gated) · tenant enforcement ✓ SPEC-01 · authorization ✓ SPEC-06 · real-time ✓ SPEC-02 · background jobs ✓ · email/SMS/voice ✓ SPEC-07 (providers TDG-06) · file storage ✓ · import processing ✓ SPEC-03 · reporting ✓ SPEC-09 · observability ✓ doc 15 · deployment ✓ SPEC-10 · testing ✓ [15](15-testing-strategy.md) · feature flags: **entitlements are the product-level flag system; engineering flags limited to boot-config, no runtime flag service until a need is demonstrated** (my decision) · secrets ✓ · backups/recovery ✓ SBX-035 + OI-1.
