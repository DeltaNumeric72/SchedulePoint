# SPEC-12 — Cross-Module Unit of Work and Transaction Ownership

**Status: `PROPOSED`.** Remediates **CAR-017** (Medium).
**Supersedes:** [04](../04-domain-boundaries.md) §§1–3 ownership rules as previously stated.
**New invariant:** **I-22**. **ADR:** [ADR-0017](../decisions/ADR-0017-cross-module-unit-of-work.md) (new).

> **What was wrong.** "A module never reads or writes another module's tables directly" is a good rule that the product's own core transactions cannot obey. Publishing a schedule must atomically write versions, assignment snapshots, audit rows, idempotency records, and the outbox — nominally owned by four modules. The rule as written forced teams to choose between direct table writes (violating ownership) and emitting events before commit (allowing partial state). Both patterns would have appeared, producing a distributed monolith inside one process.

---

## 1. The invariant

**I-22 — Every workflow that changes state has exactly one owning module, exactly one commit point, and reaches other modules' data only through their published domain ports. Effects outside that transaction happen only after commit, via the outbox.**

---

## 2. Three write classes

The previous model had one rule for three genuinely different situations.

| Class | Definition | Mechanism |
|---|---|---|
| **W1 · Own-aggregate write** | A module writing its own tables | Direct, through its repository |
| **W2 · In-transaction port call** | The owning module needs another module's invariant enforced **inside** the same commit | A **synchronous domain port** exposed by the owning module of those tables, executed on the caller's unit of work. **Never a direct table write** |
| **W3 · Post-commit reaction** | A consequence that must not affect the commit | **Outbox event**, dispatched after commit |

**W2 is what was missing.** It preserves ownership — the owning module still validates its own invariants — while allowing one transaction.

### 2.1 The port contract

A domain port for W2:

| Rule | Detail |
|---|---|
| Exposed by the module that **owns** the tables | Ownership is unchanged |
| Accepts the caller's unit of work; **does not open its own** | One transaction ([SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §4.2) |
| Enforces the owner's invariants | The point of the port |
| Returns a result or raises; **never swallows a failure** | Failure aborts the whole transaction |
| **Emits no external effect** | No provider call, no broadcast, no notification |
| **Publishes no event directly** | It may *stage* an outbox row; dispatch is post-commit |
| Declared in an explicit port registry | So the dependency is reviewable, not incidental |

**A cycle among W2 ports is prohibited and checked in CI.** W3 may flow in any direction, because it is post-commit and asynchronous.

---

## 3. Transaction owners

**One owner per workflow. This table is normative.**

| Workflow | Owner | W2 ports called | W3 effects |
|---|---|---|---|
| **Schedule publication** | **M-12 Publication** | M-11 assignment snapshots; M-24 audit; M-09 requirement check | `SchedulePublished`; notifications; report invalidation |
| **Manual assignment edit** | **M-11 Assignments** | M-24 audit | `AssignmentChanged` |
| **Build result application** | **M-12 Publication** | M-10 result read; M-11 snapshot write; M-24 audit | `ScheduleVersionCreated` |
| **Vacation commit** | **M-14 Vacation** | M-11 snapshots; M-12 draft version; M-24 audit | `VacationCommitted` |
| **Request decision** | **M-13 Requests** | M-24 audit | `RequestDecided` |
| **Opportunity claim** | **M-15 Opportunities** | M-11 snapshot replacement; M-05 qualification check; M-24 audit | `OpportunityClaimed` |
| **Swap execution** | **M-16 Swaps** | M-11 (both legs); M-05; M-24 | `SwapExecuted` |
| **Picklist selection** | **M-17 Picklists** | M-11 snapshot creation; M-24 audit | `TurnResolved`, `WorkItemTaken` |
| **Picklist correction** | **M-17 Picklists** | M-12 new version; M-11 snapshots; M-24 | `SelectionCorrected` |
| **Import apply** | **M-07 Integrations** | **M-08 boundary (mandatory, first)**; M-17 work items; M-24 | `ImportApplied` |
| **Report request** | **M-21 Reports** | M-24 audit | `ReportQueued` |
| **Entitlement change** | **M-04 Entitlements** | M-24 audit; authorization-version bump | `EntitlementChanged` |
| **Capability grant** | **M-03 Memberships** | M-24 audit; authorization-version bump | `PrincipalAuthorizationChanged` |

**Reading is freer than writing:** a module may read another's data through a **published read model or query port**. Reading does not create ownership ambiguity; writing does.

---

## 4. Module count rationalisation (CAR-017 / operational complexity)

The review observed that 25 modules over one schema is too rigid. **Six merges, where two modules shared every invariant and every transaction and had no independent scaling need:**

| Merged | Into | Rationale |
|---|---|---|
| M-09 Schedule Demand + M-12 Publication | **M-09/12 Schedule Lifecycle** | Requirements, versions, and publication commit together in every workflow |
| M-15 Opportunities + M-16 Swaps | **M-15/16 Marketplace** | Identical invariants, identical version binding ([SPEC-13](SPEC-13-marketplace-version-binding.md)), constant cross-calling |
| M-18 Notification Preferences + M-19 Delivery | **M-18/19 Notifications** | Preferences exist only to serve delivery |
| M-22 Calendar Feeds + M-23 Documents | **M-21/22/23 Artifacts** *(with M-21 Reports)* | One storage port, one signed-URL contract, one authorization pattern ([SPEC-09](SPEC-09-report-snapshot-and-artifact-authorization.md)) |

**25 → 19 modules.** M-08 Ingestion Privacy stays separate and dependency-free — merging it would defeat [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md). M-24 Audit stays separate for the separation-of-duties reason in [SPEC-11](SPEC-11-audit-assurance-and-security-boundaries.md).

**This is a boundary change, not a capability change. All 58 capabilities are unaffected.**

---

## 5. Sequence overlay — publication

```mermaid
sequenceDiagram
    participant U as Scheduler
    participant P as M-09/12 Publication (OWNER)
    participant A as M-11 Assignments
    participant AU as M-24 Audit
    participant OB as Outbox
    participant W as Worker (post-commit)

    U->>P: publish(version, idempotency_key)
    activate P
    Note over P: BEGIN — one unit of work, SPEC-01 §4
    P->>P: W1 lock period; check state; allocate number
    P->>A: W2 port: materialise snapshots (A enforces D-1a/D-1b)
    A-->>P: ok / raise
    P->>AU: W2 port: append audit (AU enforces append-only)
    P->>OB: W1 stage outbox row
    Note over P: COMMIT — the single commit point
    deactivate P
    P-->>U: published
    OB-->>W: W3 after commit
    W->>W: notifications, report invalidation, feed refresh
```

**A required sequence overlay exists for each of the 13 workflows in §3.** Publication, picklist selection, and import apply are drawn; the remainder follow the same shape and are asserted by the §6 test.

---

## 6. Test contract

| # | Test | Required outcome |
|---|---|---|
| U-01 | Each §3 workflow | **Exactly one commit point** in a transaction trace |
| U-02 | Static analysis of table access | **No module writes another's tables directly.** W2 ports only |
| U-03 | W2 port dependency graph | **Acyclic** |
| U-04 | Any W3 effect observed before commit | **Hard failure** |
| U-05 | Force failure inside each W2 port | **Whole transaction rolls back; no partial state; no event** |
| U-06 | Nested unit of work with a different tenant | Throws ([SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) T-12) |
| U-07 | Provider call attempted inside a transaction | **Lint and runtime guard both fail** |

---

## 7. Traceability

**Capabilities:** CAP-014, CAP-019, CAP-023, CAP-026, CAP-027, CAP-031, CAP-040, CAP-046, CAP-055.
**ADRs:** [ADR-0001](../decisions/ADR-0001-application-topology.md) (revised), [ADR-0009](../decisions/ADR-0009-job-and-event-reliability.md), **[ADR-0017](../decisions/ADR-0017-cross-module-unit-of-work.md) (new)**.
**Gates:** `G-ARCH`, `G-BETA`, `G-PROD`. **None passed.**
