# CLAUDE.md — SchedulePoint

**Installed at the repository root.** Generated at M0 (OPUS-M0-002) from
[`docs/architecture/drafts/CLAUDE.md`](docs/architecture/drafts/CLAUDE.md) plus the
thirteen non-bypass rules in
[`docs/fable/17-opus-agent-runbook.md`](docs/fable/17-opus-agent-runbook.md) §1. The
drafts remain in place, unmodified, as the historical source. Where this file and a
draft disagree, **this file and the runbook win** — the runbook absorbs and supersedes
the drafts for delegation purposes.

---

## What this repository is

**SchedulePoint** is a physician and clinical-staff workforce-scheduling product. It is
an **independently designed** product informed by a **clean-room behavioural
investigation** of a comparable system.

**Current state: research, architecture, and a repository scaffold. There is no product
feature code.**

| Path                              | Contents                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `schedulepoint-research/reports/` | 24 numbered research reports plus a coverage audit                                           |
| `docs/architecture/`              | The architecture proposal (19 documents, 23 ADRs, 16 SPECs), **all `PROPOSED`**              |
| `docs/fable/`                     | Product specification, plans, testing strategy, roadmap, task packets                        |
| `spikes/`                         | Executed spikes and their reports — evidence, never production code                          |
| `apps/`, `packages/`, `solver/`   | The scaffold: skeletons and CI gates only. No domain logic, no migrations, no product routes |

---

## The thirteen non-bypass rules

These are quoted **verbatim** from the runbook ([17](docs/fable/17-opus-agent-runbook.md) §1),
which took them from the linted drafts. They are binding on every task.

> **Thirteen non-bypass rules (from the linted drafts, binding):** never bypass the
> unit-of-work; never use session-scoped `SET` for tenant context; never disable/bypass
> RLS; never skip entitlement or capability checks; never mutate a published version;
> never write audit rows outside the chain; never treat manual scheduling as the
> production mechanism; never add free text to protected ingestion paths; never log
> delivery material or payload bodies; never weaken/skip accessibility or architecture
> tests; never expand capability scope; never implement a pending decision's non-default
> branch; never remove or renumber a stable ID.

Individually, with the reason each one exists and how it is enforced here:

| #   | Rule                                                          | Why                                                                                                                                                                                                                                                                           | Enforcement in this repository                                                                                                          |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **never bypass the unit-of-work**                             | I-15. Outside it, RLS returns zero rows — **if you are tempted to "just add a direct query," that is the failure mode, not the workaround**                                                                                                                                   | `packages/domain/src/ports/unit-of-work.ts` is the only handle; the runner owns the transaction boundary so no caller can end one early |
| 2   | **never use session-scoped `SET` for tenant context**         | S-03b. A session-scoped setting survives into the next borrower of a pooled connection. And per SPIKE-REPORT §7.2, _every_ `SET` form — including `SET LOCAL` — requires interpolating the tenant id into SQL. `set_config(name, value, true)` is the sole permitted spelling | ESLint `no-restricted-syntax`, proved by `scripts/red-cases/lint/`                                                                      |
| 3   | **never disable/bypass RLS**                                  | Including "temporarily," including in a test that then ships                                                                                                                                                                                                                  | `scripts/gates/migration-rls-check.mjs`: a `CREATE TABLE` without ENABLE + FORCE + a policy **in the same migration** fails the build   |
| 4   | **never skip entitlement or capability checks**               | I-03: entitlement asks whether the organization has the module; permission asks whether this person may act. I-19: every protected operation re-evaluates against current state                                                                                               | `scripts/gates/route-policy-check.mjs`: every registered route must declare a policy                                                    |
| 5   | **never mutate a published version**                          | I-18. Amend by publishing forward; supersession never deletes history                                                                                                                                                                                                         | Database rules, when the schema lands (ADR-0007)                                                                                        |
| 6   | **never write audit rows outside the chain**                  | ADR-0019. Never delete an audit row, break the hash chain, or add an update path to the audit module                                                                                                                                                                          | Audit module design; no audit code exists yet                                                                                           |
| 7   | **never treat manual scheduling as the production mechanism** | I-05. It is override, recovery, fixed-assignment input, and development-stage only                                                                                                                                                                                            | Review; no scheduling code exists yet                                                                                                   |
| 8   | **never add free text to protected ingestion paths**          | I-17. Use the controlled vocabulary                                                                                                                                                                                                                                           | Ingress enclave (`Dockerfile.ingress`); enforcement lands with SPEC-03                                                                  |
| 9   | **never log delivery material or payload bodies**             | I-17, SPEC-07 §3. Not in logs, errors, traces, queues, audit payloads, or backups                                                                                                                                                                                             | `apps/api/src/http/errors.ts` returns a fixed 5xx message; `ingress.nginx.conf` uses a log format with no body and no query string      |
| 10  | **never weaken/skip accessibility or architecture tests**     | CAP-066. A failing axe-core check is a defect, not an obstacle. Add tests; do not subtract them                                                                                                                                                                               | `apps/web/e2e/shell.spec.ts` (axe, two viewports) and the dependency-cruiser boundary, both with red-case proofs                        |
| 11  | **never expand capability scope**                             | Scope is owner-controlled. Equally: never _drop, defer, or narrow_ a capability from the 58-capability baseline                                                                                                                                                               | Review against [18](docs/architecture/18-capability-traceability.md)                                                                    |
| 12  | **never implement a pending decision's non-default branch**   | All formerly-pending product decisions were resolved 2026-08-01 under delegated authority ([21-decision-resolution](docs/fable/21-decision-resolution.md)) — to their recorded defaults. Implementing any NON-default branch still requires a recorded decision change first                                                                                                                                                            | Review against [19](docs/architecture/19-risks-and-decisions.md)                                                                        |
| 13  | **never remove or renumber a stable ID**                      | A stable ID that silently changes meaning corrupts every document that cites it, and the citation still looks correct                                                                                                                                                         | `scripts/gates/invariant-id-uniqueness.mjs`, which exists because `I-05` once meant two different things (CAR-023)                      |

**Each of these has been bypassed in a real system by someone who believed they had a
good reason. None of them is negotiable, and none has an exception you may grant
yourself.**

---

## Non-negotiable rules

### 1. The clean-room boundary

**Never reproduce proprietary source code, private APIs, algorithms, assets, copy, or
database structures from any source product.**

- The comparable product's **scheduling algorithm is unknown.** Do not reconstruct or
  approximate it. SchedulePoint has its own model
  ([08](docs/architecture/08-automated-scheduling-engine.md)).
- **Do not visit or interact with the source product.** Research is complete.
- **Do not introduce any organization, site, or person name from the research** into
  code, comments, fixtures, or tests.

### 2. Evidence classification is load-bearing

The research corpus classifies every statement as `OBSERVED`, `INFERRED`, `UNRESOLVED`,
`SCHEDULEPOINT-REQUIREMENT`, or `SCHEDULEPOINT-RECOMMENDATION`.

**Never convert an inference or a recommendation into an observed fact.** If something is
`UNRESOLVED`, it stays `UNRESOLVED` — including when a cleaner narrative would result
from resolving it.

### 3. Capabilities are never silently dropped

The **58 capabilities** in
[report 19](schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md)
are the authoritative scope.

**A capability may not disappear because it is difficult, expensive,
integration-dependent, unobserved, or inconvenient.** These dispositions are prohibited:
`excluded`, `abandoned`, `optional because difficult`, `indefinitely deferred`,
`post-MVP with no production gate`.

Sequencing by milestone is fine. **Deletion is not.**

### 4. Approved decisions are binding

**PO-DEC-02** (four-layer authorization) · **PO-DEC-18** (server-authoritative real-time) ·
**PO-DEC-04** (first-class entitlements) · **PO-DEC-08** (platform-enforced ingestion
boundary).

**The other 18 product decisions are pending.** Their working defaults may be used for
planning. **Do not mark any of them approved.**

### 5. The architectural invariants

The full register is [01](docs/architecture/01-architecture-overview.md) §4 (I-01..I-22).
Every ID is unique and means exactly one thing; a CI check asserts it. Those the scaffold
already touches:

| Invariant     | Rule                                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I-02**      | Authorization is **deny-by-default**; an operation with no policy fails closed and fails its automated test                                                                                                                                                                                                                      |
| **I-07**      | **No patient-identifying information or clinical free text enters the system** — not in tables, logs, errors, queues, audit payloads, traces, or backups                                                                                                                                                                         |
| **I-10**      | **One user action produces one request** — no amplification                                                                                                                                                                                                                                                                      |
| **I-11**      | **A notification failure never rolls back a domain change**                                                                                                                                                                                                                                                                      |
| **I-12**      | Every interactive element meets **SP-HR-3..6** accessibility requirements                                                                                                                                                                                                                                                        |
| **I-13**      | **No control labelled Add, New, or Create may persist anything before a completed form, validation, and an explicit Save.** This comes from a real incident in which such a control created a live record on click. **(Renumbered from `I-05`, which means mandatory automated scheduling — the collision was finding CAR-023)** |
| **I-14/I-15** | **Tenant context is client-declared and server-verified; no statement touches a tenant table outside a unit of work with transaction-local context**                                                                                                                                                                             |
| **I-16**      | **A picklist turn produces at most one accepted selection, through one transaction**                                                                                                                                                                                                                                             |
| **I-18**      | **A published schedule version is immutable in the database**                                                                                                                                                                                                                                                                    |
| **I-19**      | **Every protected operation re-evaluates authorization against current state**                                                                                                                                                                                                                                                   |

### 6. The client talks to no third party

**Never introduce an outbound third-party host from the browser or client telemetry.**
CAP-068 / T-23. This is the strict, absolute rule, and the allowlist in
`scripts/gates/client-host-allowlist.json` is empty.

Server-side is a _different question_, corrected by CAR-023: **server-side processors are
permitted when registered in the processor register with a declared payload schema,
residency, and retention** ([SPEC-07](docs/architecture/specs/SPEC-07-notification-delivery-contracts.md) §7).
The client-side prohibition is unchanged and unconditional.

### 7. Safety when running anything

- **Synthetic data only.** No real patient data, no real staff data, no real customer
  name — including in screenshots and logs.
- **No test may send a notification to a real person.** Controlled endpoints only.
- **No test runs against a live production organization of any system.**
- **Never claim HIPAA, PHIPA, SOC 2, ISO 27001, or GDPR compliance or readiness.** The
  required legal and operational work is explicitly not done
  ([14](docs/architecture/14-security-and-privacy.md) §11).

---

## Delegation and orchestration (standing owner directives)

These are directives the product owner has given the orchestrator. They are recorded
here so every session — local or Claude Code on the web — operates under them without
needing the original conversation.

### 1. The 2026-08-01 expanded-authority mandate

The owner's "Expanded decision authority and final planning mandate" (2026-08-01)
delegates **all remaining product, architecture, planning, sequencing, and quality-gate
decisions** to the Fable orchestrator. **Reserved to the owner, always:**
purchases/contracts · production accounts, domains, and credentials · real-hospital
connections · real personal or clinical data · real notifications · legal
representations · production deployment. The auditable record of every decision taken
under the mandate is [21-decision-resolution](docs/fable/21-decision-resolution.md);
subsequent delegated rulings are recorded as FADs in the task log in the same style.

### 2. Fable orchestrates; Opus executes (2026-08-10)

Every implementation and review sub-agent is launched on **Claude Opus
(`model: "opus"`, high reasoning effort)**. Fable — the orchestrating session — authors
the self-contained task packet (packet text, worktree, acceptance battery, escalation
rules), adjudicates results, and runs acceptance; it does **not** execute packets
itself. Reason: during M4-000A, Fable-model executors repeatedly exhausted usage limits
mid-packet; running executors on Opus preserves the orchestrator's budget for
delegation, review, and adjudication.

### 3. Within-milestone autonomy

Implementation authorization was given per
[24-execution-standards](docs/fable/24-execution-standards.md) §G (M0–M4 executed under
it). Once a milestone's packets are ratified, sub-agent delegation proceeds **without
per-task owner approval**, with the task log updated at every acceptance
([19-decisions-needed](docs/fable/19-decisions-needed.md) §4 "Standing authorities").
Escalation remains success behaviour — the runbook's escalation rules are unchanged by
this autonomy.

---

## Working in this repository

### Commands

```bash
corepack pnpm install     # dependencies (corepack only — see docs/dev-setup.md)
corepack pnpm check       # every gate, in dependency order. This is the bar
corepack pnpm red-cases   # prove each gate still fails on its violation
```

`pnpm check` runs twelve build-failing gates: lint · typecheck · unit tests · import
boundary · route-without-policy · migration+RLS pairing · invariant-ID uniqueness ·
secret scan · production build · network-assertion guard · axe-core · request budget.

### Layering

```
packages/domain     imports NOTHING
packages/contracts  imports zod
apps/api            imports domain + contracts
apps/web            imports contracts
```

Enforced by `.dependency-cruiser.cjs`, proved by `scripts/red-cases/import-boundary/`.

### Before changing architecture

Read [01](docs/architecture/01-architecture-overview.md) for the invariants and
[19](docs/architecture/19-risks-and-decisions.md) for what is decided versus pending. If a
change contradicts an ADR, **write a superseding ADR — do not edit the existing one
silently.** If a change touches an invariant, update
[01](docs/architecture/01-architecture-overview.md) §4 and the validator in the same
change.

### Before adding a capability-bearing feature

Find it in [18](docs/architecture/18-capability-traceability.md). If it is not there, it is
out of scope until the baseline changes.

### Terminology

The glossary ([report 12](schedulepoint-research/reports/12-product-glossary.md)) has 88
defined terms. Use them exactly. Ten distinct schedule concepts are deliberately kept
separate ([07](docs/architecture/07-schedule-and-publication.md)) — do not collapse them.

### Report honestly

If a test fails, say so with the output. If a step was skipped, say that. **Do not
describe designed behaviour as verified behaviour.** A return without command output is
treated as unverified.

**Escalation is success behaviour.** A sub-agent is never penalised for stopping; it is
rejected for improvising. Stop and report when: the packet conflicts with a SPEC or
invariant · a needed schema change is not in the packet · a test can only pass by
weakening it · a pending decision's default is insufficient · there is any security or
privacy doubt · the task needs data or credentials it does not have.

---

## Status vocabulary

| Term          | Means                                              |
| ------------- | -------------------------------------------------- |
| `PROPOSED`    | Written down. Not approved                         |
| `APPROVED`    | The product owner has explicitly agreed            |
| Gate `passed` | **Evidence exists.** Only evidence closes a gate   |
| `UNRESOLVED`  | Research could not establish it. It stays that way |

**Never mark an ADR accepted, a decision approved, or a gate passed.** Only the product
owner does the first two; only evidence does the third.
