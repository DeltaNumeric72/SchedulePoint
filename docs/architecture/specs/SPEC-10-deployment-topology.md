# SPEC-10 — Deployable Topology, Availability, and Recovery

**Status: `PROPOSED`.** Remediates **CAR-013** (High).
**Supersedes:** [17](../17-deployment-and-operations.md) §§1–9; [ADR-0015](../decisions/ADR-0015-deployment-topology.md) as previously written.

> **What was wrong.** ADR-0015 deliberately left platform, region, residency, database HA, queue technology, RPO/RTO, and DR topology open. **Deferring the provider was defensible; deferring the *architecture* was not.** PostgreSQL is simultaneously the database, the queue, the outbox, the coordination point, and the real-time source of truth, yet failover, fencing, and object-store consistency were unspecified. "Affinity by picklist" is not a leader-election design.
>
> **This specification decides the topology and the failure semantics. It still does not invent a customer residency requirement** — that is owner input, recorded as such in §9.

---

## 1. What is decided here versus what remains owner input

| Decided now | Still owner input |
|---|---|
| Deployment **class** (§2) | Specific cloud provider and region |
| Process classes and container boundaries (§2) | Instance sizing and cost envelope confirmation |
| Database HA model and **fencing semantics** (§4) | Managed vs. self-managed product choice |
| Queue recovery semantics (§5) | — |
| Coordinator leases (§6) | — |
| Solver isolation (§7) | — |
| Backup, PITR, object-store consistency (§8) | **RPO/RTO targets** (§9) |
| Migration expand/contract and rollback limits (§10) | — |
| Regional and provider failure behaviour (§11) | **Data residency obligations** (§9) |

---

## 2. Deployment class and process classes

**Decision: managed container platform + managed PostgreSQL + managed S3-compatible object storage + managed secret store.**

| Rejected | Why |
|---|---|
| Self-managed Kubernetes | Substantial operational surface for a small team and unmeasured load |
| Self-managed PostgreSQL | HA, failover, and PITR are exactly what a small team gets wrong |
| Serverless functions | Long solver runs and persistent WebSockets fit poorly; cold starts hurt turn latency |
| Single VM | No HA story at all |

### 2.1 Six process classes

**Five previously; the ingress enclave ([SPEC-03](SPEC-03-raw-ingress-trust-boundary.md)) and the solver worker ([SPEC-04](SPEC-04-solver-runtime-and-rule-model.md)) are now distinct.**

| # | Class | Runtime | Image | Scales with | State |
|---|---|---|---|---|---|
| 1 | **Web / API** | Node.js LTS | `app` | Concurrent users | Stateless |
| 2 | **Background workers** | Node.js LTS | `app` | Queue depth | Stateless; idempotent jobs |
| 3 | **Real-time coordinator** | Node.js LTS | `app` | Concurrent live picklists | **Lease-holding**, durable state in PostgreSQL |
| 4 | **Solver worker** | **Python** | **`solver`** | Concurrent builds | Stateless; one subprocess per solve |
| 5 | **Ingress enclave** | Minimal (Node.js LTS, reduced deps) | **`ingress`** | Connector traffic | **Stateless, no disk, no DB credential** |
| 6 | **Migration runner** | Node.js LTS | `app` | One-shot | Runs as `app_migrator` |

**Three images, not one.** The "one image across all process classes" claim is withdrawn (CAR-005). Classes 1–3 and 6 share `app`; the solver and enclave are separately built, separately scanned, and separately patched.

### 2.2 Connector ingress network path *(new subsection, 2026-08-01, V-17)*

> **AMENDED 2026-08-01 (V-17)** — [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) §2 places *"TLS terminate — inside the enclave"* as the first node of the trust boundary, and CAR-004's boundary-placement hole was precisely that the old boundary sat **downstream of TLS termination**. This document defined process class 5 and then **never mentioned TLS, ingress termination, load balancing, or pass-through anywhere** — while §1 selects a managed container platform, and every mainstream managed container platform terminates TLS at a platform-managed load balancer or ingress controller **by default**, with components that commonly emit access logs, support WAF body inspection, and buffer request bodies. Built to this document as previously written, the raw payload would reach platform infrastructure before the enclave saw it, outside E-1..E-12. This subsection is the missing requirement ([rationale](../remediation/internal-verification-corrections.md) §2).

**Normative requirement — this is [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) `E-13`.** Connector ingress reaches process class 5 over a **dedicated network path with TCP/SNI pass-through**. The platform load balancer routes on the unencrypted TLS SNI header and forwards the encrypted stream byte-for-byte to the enclave, which terminates TLS itself.

| # | On the connector ingress path | Requirement |
|---|---|---|
| N-1 | **TLS termination or re-encryption at the platform edge** | **Prohibited.** Termination happens inside the enclave and nowhere else |
| N-2 | **HTTP-layer access logging** (path, query, headers, body, or any fragment) | **Prohibited.** L4 connection-level logging — source address, byte counts, connection duration, SNI name — is permitted and is what operations uses |
| N-3 | **Request or response body buffering** to disk or memory outside the enclave | **Prohibited** |
| N-4 | **WAF / IDS body inspection** | **Prohibited on this path.** L3/L4 controls (rate limiting, connection limits, IP allowlisting) are permitted and encouraged |
| N-5 | **API-gateway request capture, mirroring, sampling, or replay** | **Prohibited** |
| N-6 | **Shared listener with the `app` classes** | **Prohibited.** The enclave has its **own listener, its own hostname, and its own load-balancer target group**, so no `app`-path logging or inspection policy can be applied to it by inheritance or by default |
| N-7 | **Configuration attestation** | The deployed configuration is dumped and verified under [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) **C-4** at connector certification, and re-verified on any change to the ingress configuration |
| N-8 | **Canary evidence** | Platform ingress surfaces are swept as **S-17** in [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) §7.2. A canary found there is a hard failure of `G-CONN` |

**Provider selection is constrained by this.** A managed container platform that cannot expose a TCP/SNI pass-through listener — or that cannot disable edge body logging and inspection on a specific listener — **cannot host process class 5**, and that is a selection criterion under §1's owner-input column, not an implementation detail to be discovered later. If no acceptable provider path exists, the enclave runs on a dedicated network path outside the container platform's shared ingress; what is not permitted is quietly accepting edge termination.

---

## 3. Region topology

| Element | Design |
|---|---|
| **Primary region** | All six process classes; primary PostgreSQL; object storage |
| **Secondary availability zone** | PostgreSQL standby; stateless classes spread across zones |
| **Cross-region** | **Backups and object-store replication only.** No warm standby in the initial topology — see §11 |
| **Regional loss** | **Recovery from backup into a new region.** RTO is hours, not minutes. **This is stated plainly rather than implied to be better** |

---

## 4. PostgreSQL high availability and fencing

| Element | Design |
|---|---|
| **Topology** | Managed primary with a synchronous standby in a second zone |
| **Failover** | Provider-managed; the application reconnects through a single endpoint |
| **Replication mode** | **Synchronous commit** for the primary. Cost: write latency. Benefit: **zero committed-transaction loss on zone failover**, which is the correct trade for a system that decides who works |
| **Read replicas** | **Not used for turn-critical or authorization reads.** Permitted only for reporting, and only where a stated staleness bound is acceptable |
| **Application-side fencing** | See below |

### 4.1 The split-brain problem, and why the application does not depend on solving it

The review's scenario: *failover promotes a lagging replica while an old coordinator remains alive; two coordinators advance one picklist.*

| Layer | Protection |
|---|---|
| **Database** | The managed service fences the demoted primary. **We do not implement our own promotion logic** |
| **Application** | **The coordinator lease and fencing token ([SPEC-02](SPEC-02-picklist-turn-transaction.md) §6) live in the database itself.** A coordinator that reconnects after a failover reads the current token; if another coordinator has taken the lease, its writes are rejected at step 09 |
| **Why this composes** | Both coordinators talk to whichever database is authoritative. **They cannot disagree, because the arbiter is the row they both read** — not a clock, not a heartbeat, not a consensus protocol we wrote |
| **Residual** | If the database itself split-brained, the guarantee would fail. **That risk is delegated to the managed provider and named in [19](../19-risks-and-decisions.md) RISK-27** |

---

## 5. Queue and outbox recovery

| Failure | Behaviour |
|---|---|
| **Worker crashes mid-job** | The claim lease expires; the job is re-claimed. **Idempotency makes re-execution safe** |
| **Failover mid-dispatch** | Uncommitted claims roll back; committed ones are visible to the new primary |
| **Outbox relay crash after provider call, before recording** | Attempt reconciles as `ambiguous` ([SPEC-07](SPEC-07-notification-delivery-contracts.md) §4.2) |
| **Backlog** | Depth and age alerts; workers scale horizontally; **priority separation prevents a bulk import starving a picklist notification** |
| **Poison job** | Bounded retries, then dead-letter with a metadata-only record. **Alert, never silent** |
| **Reconciler** | Sweeps stuck states after any failover: `publishing` versions with no outcome → `approved`; expired coordinator leases → released; `ambiguous` deliveries → reconciliation window; orphan artifacts → [SPEC-09](SPEC-09-report-snapshot-and-artifact-authorization.md) §7 |

---

## 6. Real-time coordinator model

| Element | Design |
|---|---|
| **Assignment** | Any coordinator may serve any client. **There is no sticky routing requirement**, because coordinators relay a durable event log rather than owning state |
| **Lease** | Per picklist, in PostgreSQL, with a monotonic fencing token ([SPEC-02](SPEC-02-picklist-turn-transaction.md) §6) |
| **Who needs the lease** | **Only mutating operations** — timer sweeps and advancement. Read-only relay never does |
| **Lease loss** | The instance stops sweeping. Clients stay connected and keep receiving relayed events |
| **Instance loss** | Clients reconnect with **backoff and jitter**; another instance acquires the lease on expiry |
| **Scaling** | Horizontal on connection count. **Connections scale with live features, not page views** (I-10) |

---

## 7. Solver resource isolation

| Control | Design |
|---|---|
| **Dedicated node pool** | CPU-optimised; **separate from web and worker pools**, so a solve cannot starve a request |
| **Per-solve limits** | CPU, memory, and wall-clock, enforced at the container and at the solver |
| **Per-organization concurrency cap** | One tenant's large build cannot exhaust capacity for everyone |
| **Queueing** | Saturation queues builds with a visible position. **It never degrades the web tier and never silently drops a build** |
| **Subprocess per solve** | Required for kill-based cancellation ([SPEC-04](SPEC-04-solver-runtime-and-rule-model.md) §2) |
| **Image retention** | Solver images retained **by digest** for the reproducibility window (§8) |

---

## 8. Backup, PITR, and object-store consistency

| Element | Design |
|---|---|
| **Database** | Automated backups + **continuous WAL archiving for PITR** |
| **Object storage** | **Versioned** buckets, cross-region replication, encryption at rest |
| **Consistency across the two** | The database is authoritative. After any restore to time *T*, the reconciler ([SPEC-09](SPEC-09-report-snapshot-and-artifact-authorization.md) §7) resolves orphan objects and dangling rows. **Report artifacts are regenerable from their durable manifests, which is what makes the divergence recoverable** |
| **Restore rehearsal** | **SBX-035**, into an **isolated DR environment — never into staging**. Verifies audit continuity, schedule history, and canary absence ([SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) §7.2 S-10) |
| **Secret store** | Backed up and rotated independently. **A database restore without the corresponding key version yields unusable encrypted material — deliberately** |
| **Solver image registry** | Retained by digest for the reproducibility window; **retention is a named cost obligation** |
| **Backup encryption keys** | Separate trust domain from the runtime keys ([SPEC-11](SPEC-11-audit-assurance-and-security-boundaries.md) §6) |

---

## 9. Owner input still required — recorded, not invented

| # | Item | Owner | Blocking |
|---|---|---|---|
| **OI-1** | **RPO target** | Product owner + first customer | `G-PROD`. Synchronous commit makes an RPO near zero for zone failure *achievable*; **the committed target is not ours to set** |
| **OI-2** | **RTO target** | Product owner | `G-PROD`. Regional recovery is hours in this topology; **if the owner needs minutes, a warm standby is required and the cost changes materially** |
| **OI-3** | **Data-residency obligations** | **Legal + each customer** | `G-PROD`. **No residency requirement is invented here.** Canadian healthcare customers *may* require in-country storage; whether they do is a contractual fact we do not have |
| **OI-4** | Cloud provider and region | Product owner | Provisioning |
| **OI-5** | Managed vs. self-managed PostgreSQL product | Product owner | Provisioning |
| **OI-6** | Support model and on-call rotation | Product owner | `G-PROD` |
| **OI-7** | Cost envelope approval | Product owner | Provisioning |

**The architecture is provider-portable by construction** (§12), so OI-4 and OI-5 do not block design — only provisioning.

---

## 10. Migrations

| Rule | Detail |
|---|---|
| **Expand → migrate → contract** | Old and new code both run during a rolling deploy |
| **No destructive change** in the same release as the code that stops using a column | A rollback must still find its data |
| **Every tenant table's migration adds its RLS policy** (D-10) | CI-enforced |
| **Every migration declares a rollback path** — or **explicitly declares itself irreversible** | An irreversible migration requires named approval |
| **Backfills are jobs, not migrations** | A migration holding a lock is an outage |
| **Trigger-protected tables** ([SPEC-05](SPEC-05-schedule-version-identity-and-publication.md) §4) | A corrective migration touching published rows runs as `app_migrator`, is **two-person approved**, and is audited |

### 10.1 Rollback limits, stated honestly

| Rollback | Possible? |
|---|---|
| Application image | **Yes**, within the expand/contract window |
| Additive migration | **Yes** |
| Destructive migration | **No** — restore from backup |
| Data transformed by a backfill | **Only** if the backfill wrote a reversible record |
| **Published schedule version** | **Never rolled back.** Revert publishes forward ([SPEC-05](SPEC-05-schedule-version-identity-and-publication.md) §6.1) |

---

## 11. Failure-mode matrix

| Failure | Behaviour | Evidence |
|---|---|---|
| One web instance | Load balancer removes it; no user impact | Load test |
| One worker | Jobs re-claimed after lease expiry | SBX-035 ext. |
| One coordinator | Clients reconnect; lease reassigned | [SPEC-02](SPEC-02-picklist-turn-transaction.md) P-08 |
| **Database zone failover** | Managed promotion; app reconnects; **fencing tokens prevent double advancement** | **SBX-035 ext.: failover during publication and during picklist selection** |
| Object-store outage | Uploads and downloads fail explicitly; **schedule operations continue** | Fault injection |
| Provider outage (notification) | Retries, dead-letter, alert; **domain state unaffected** | [SPEC-07](SPEC-07-notification-delivery-contracts.md) N-13 |
| Solver pool saturation | Queued with visible position | [SPEC-04](SPEC-04-solver-runtime-and-rule-model.md) S-16t |
| Ingress enclave loss | Imports stop; **nothing partial persists**; sources re-send or are re-fetched | [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) I-06 |
| **Regional loss** | **Restore from backup into a new region. RTO in hours** | DR rehearsal |
| Secret-store outage | New sessions and provider calls fail; **existing work continues** | Fault injection |

---

## 12. Portability constraints that keep the provider decision cheap

The same immutable artifact promotes through every environment and is never rebuilt · configuration by environment variable and secret store, never baked in · **no provider-proprietary API in domain code** · storage accessed through an S3-compatible interface · queue semantics through a port · **provider-specific behaviour confined to adapters**.

---

## 13. Required runbooks

**Ten previously named, plus four the redesign introduces. None is written.**

Solver stuck or timing out · picklist stalled or deadlocked · notification dead-letter backlog · import quarantine backlog · **coordinator restart during a live picklist** · **database failover during publication** · migration rollback · suspected tenant-isolation incident · calendar-token compromise · connector credential rotation · **ingress enclave compromise** · **backup-key compromise** · **break-glass access** · **PITR restore and reconciliation**.

---

## 14. Traceability

**Capabilities:** CAP-003, CAP-031, CAP-032, CAP-040, CAP-051, CAP-055, CAP-067.
**Decisions:** PO-DEC-18 (approved), PO-DEC-23 (pending).
**ADRs:** [ADR-0001](../decisions/ADR-0001-application-topology.md) (revised), [ADR-0015](../decisions/ADR-0015-deployment-topology.md) (revised), [ADR-0020](../decisions/ADR-0020-solver-runtime-packaging.md), [ADR-0021](../decisions/ADR-0021-raw-ingress-enclave.md).
**Gates:** `G-ARCH`, `G-PROD`. **None passed. Nothing is provisioned.**
