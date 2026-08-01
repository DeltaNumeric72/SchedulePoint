# 17 — Deployment and Operations

**Status: `PROPOSED`.** Implements CAP-051 operationally and supports every capability's runtime.

> **REVISED 2026-08-01 (CAR-005, CAR-013, CAR-024).** **Deferring the deployment *architecture* is withdrawn.** Deployment class, **six process classes and three images**, region topology, database HA with synchronous commit, **application-side fencing that composes with database failover**, queue recovery, coordinator leases, solver isolation, backup/PITR/object-store consistency, migration rollback limits, and a failure-mode matrix are decided in [SPEC-10](specs/SPEC-10-deployment-topology.md). **Provider, region, residency, and RPO/RTO remain open and are recorded as owner input OI-1..OI-7 — not invented.**

> **No infrastructure is created by this task.** This document describes a target operating model. Nothing here is provisioned, and no environment exists.

---

## 1. Deployable units

Four process classes from one codebase ([01](01-architecture-overview.md) §3), each independently scalable:

| Unit | Scales with | Restart safety |
|---|---|---|
| **Web / API** | Concurrent users | Stateless — safe at any time |
| **Background workers** | Queue depth | **Jobs are idempotent; an interrupted job is retried** |
| **Scheduling workers** | Concurrent solver runs | A killed run is `failed`, never silently lost; **re-runnable from the same pinned inputs** |
| **Real-time coordinator** | Concurrent live picklists | **Durable state is in PostgreSQL; clients reconnect with backoff and jitter** |

**Why these four and not one:** a solver run consuming a core for minutes must not starve web requests; a real-time process holding thousands of connections has a completely different scaling curve from request/response. Deploying them together would force the most demanding profile onto everything.

---

## 2. Environment topology

| Environment | Data | Purpose |
|---|---|---|
| Development | Synthetic | Local and shared |
| CI | Ephemeral synthetic | Automated gates |
| Specialist (MULTI, CONC, LIVE-SIM, PERF, A11Y, DR, INTEG) | Synthetic | [16](16-testing-and-environments.md) §3 |
| Staging | **Synthetic only** | Production-like verification |
| Production | Customer data | Live |

**Staging never receives a production data copy.** A restore rehearsal (SBX-035) runs into an **isolated DR environment**, not staging.

---

## 3. Release process

Trunk-based development · every merge builds an immutable artifact · **the same artifact promotes through environments** — never rebuilt per environment · configuration by environment variable and secret store, never baked in.

**Gates before promotion to production:** all CI checks green · **the invariant-enforcing checks of [16](16-testing-and-environments.md) §2.1** · migrations reviewed for backward compatibility · **rollback path identified before deploy, not after**.

---

## 4. Migrations

| Rule | Reason |
|---|---|
| **Expand → migrate → contract** | The old and new versions must both run during a rolling deploy |
| **No destructive migration in the same release as the code that stops using a column** | If the deploy is rolled back, the data must still be there |
| **Every migration adding a tenant table also adds its RLS policy** (D-10) | CI enforces the pair |
| **Long-running backfills are jobs, not migrations** | A migration holding a lock is an outage |
| **Rollback path documented per migration** | Discovering there isn't one during an incident is too late |

---

## 5. Configuration and secrets

Environment variables for non-secret config; a **managed secret store** for everything sensitive. **No secret in the repository, in an image, or in a log.** Connector credentials referenced by `auth_ref` ([12](12-integrations-and-ingestion-privacy.md) §3). Feature flags are for **rollout**, never as a substitute for entitlements or permissions — a flag is not an access control.

---

## 6. Backup and recovery

| Aspect | Design |
|---|---|
| **Database** | Automated backups + **point-in-time recovery** |
| **Object storage** | Versioned, replicated |
| **Encryption** | At rest and in transit |
| **Restore rehearsal** | **SBX-035 — restore, verify audit integrity, verify schedule history.** Untested backups are not backups |
| **RPO / RTO** | **To be set with the product owner. Not asserted here** — a number invented in a design document is worse than an acknowledged gap |
| **Audit survival** | Explicitly verified by the rehearsal |

**Backups inherit the ingestion boundary's benefit:** patient-identifying data was never persisted, so it is not in a backup either.

---

## 7. Scaling

| Pressure | Response |
|---|---|
| Web load | Horizontal; stateless |
| Queue depth | More background workers; **priority separation so a bulk import cannot starve a picklist notification** |
| Solver demand | More scheduling workers; **per-org concurrency cap so one large build cannot exhaust capacity for everyone** |
| Real-time | More coordinator instances; connection affinity by picklist |
| Read load | Read replicas **only when measured**, with an explicit position on replica lag — stale reads on turn-critical state are unacceptable |
| Data volume | Time-partition audit and delivery-attempt tables |

**No premature distribution.** Every scaling step above is introduced when a measurement justifies it, not on day one.

---

## 8. Runbooks required before production

Solver run stuck or timing out · **picklist stalled or deadlocked** · notification dead-letter backlog · import quarantine backlog · **real-time coordinator restart during a live picklist** · database failover · migration rollback · **suspected tenant-isolation incident** · calendar-token compromise · connector credential rotation.

**None is written.** They are named so their absence is visible.

---

## 9. Open operational questions

| Question | Status |
|---|---|
| **Cloud provider and region** | **Open** |
| **Data residency** (Canadian customers may require in-country storage) | **Open — a real constraint, not a formality** |
| RPO / RTO targets | **Open** |
| Managed vs. self-managed PostgreSQL | **Open** |
| Support model and on-call rotation | **Open** |
| Incident response plan | **Open** ([14](14-security-and-privacy.md) §10) |
| Business continuity for the solver | **Open** |

**These are named rather than answered because answering them requires commercial and legal input this task did not have.** Deployment platform choice is [ADR-0015](decisions/ADR-0015-deployment-topology.md) — `PROPOSED`, with the decision deliberately left open.

---

## 10. Capability and gate mapping

**CAP-051** — observability, backup, recovery: §6, plus [15](15-audit-and-observability.md) §2.

**ADRs:** [ADR-0001](decisions/ADR-0001-application-topology.md), [ADR-0015](decisions/ADR-0015-deployment-topology.md).

**Gates:** `G-PROD` — SBX-035 (recovery). **Not executed.**
