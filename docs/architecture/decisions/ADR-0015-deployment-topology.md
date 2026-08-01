# ADR-0015 — Deployment Topology

**Status:** `PROPOSED` — 2026-07-31. Not accepted. **This ADR deliberately leaves its central choice open.**

> **REVISED 2026-08-01 (CAR-013).** **Deferring the platform *architecture* is withdrawn.** Deployment class, six process classes, three images, region topology, database HA with synchronous commit, **application-side fencing that composes with database failover**, queue recovery, coordinator leases, solver isolation, backup/PITR/object-store consistency, migration rollback limits, and a failure-mode matrix are now decided in [SPEC-10](../specs/SPEC-10-deployment-topology.md). **Provider, region, residency, and RPO/RTO remain open — recorded as owner input OI-1..OI-7 rather than invented.**

## Context

Four process classes (ADR-0001) need somewhere to run, PostgreSQL needs to be hosted, and object storage needs a provider. But the inputs that should drive those choices are commercial and legal, not technical:

- **Data residency.** Canadian healthcare customers may require in-country storage. This is a real constraint, not a formality, and it eliminates provider-region combinations outright.
- **Managed vs. self-managed PostgreSQL** depends on team size and support expectations that are not yet settled.
- **RPO and RTO targets** have not been set with the product owner.

Choosing a provider now would mean choosing before knowing what the choice has to satisfy.

## Decision

**Defer the platform choice. Specify the requirements it must meet, and constrain the design so that the deferral costs nothing.**

**Requirements any candidate platform must satisfy:**

| Requirement | Why |
|---|---|
| Four independently scalable process classes from one build | ADR-0001 |
| Managed PostgreSQL with **point-in-time recovery** | ADR-0003, backup strategy |
| S3-compatible object storage, versioned and encrypted | ADR-0014 |
| A managed secret store | ADR-0012, security |
| **Region selection satisfying data residency** | The binding legal constraint |
| Support for long-lived WebSocket connections | ADR-0008 |
| CPU-appropriate instances for solver workloads | ADR-0006 |
| OpenTelemetry ingestion | Observability |

**Design constraints that keep the deferral cheap:** the same immutable artifact promotes through every environment and is never rebuilt per environment · configuration comes from environment variables and a secret store, never baked into an image · **no provider-proprietary API is used in domain code** · migrations follow expand → migrate → contract so a rolling deploy is always safe.

## Alternatives considered

| Alternative | Why not now |
|---|---|
| **Commit to a specific cloud provider** | Would decide before data residency, RPO/RTO, and the support model are known |
| **Kubernetes from day one** | Substantial operational surface for four process classes and no measured load |
| **Platform-as-a-service** | Attractive for a small team; **remains a live candidate**, subject to WebSocket and solver-CPU support |
| **Self-hosted** | Maximum control, disproportionate operational burden |

## Consequences

**Positive:** the choice is made when its inputs exist · portability is a design constraint rather than an aspiration · the requirements list makes evaluation concrete rather than opinion-driven.

**Negative:** **operational planning is genuinely blocked until this is resolved** · cost modelling is impossible · some optimisations only available with a specific provider are unavailable in the meantime.

## Security implications

Encryption at rest and in transit are requirements regardless of provider. **Data residency is a security and legal requirement, not a preference.** Secrets never live in the repository or in an image.

## Operational implications

**Ten runbooks are named in [17](../17-deployment-and-operations.md) §8 and none is written.** RPO and RTO are unset — **and a number invented in a design document would be worse than an acknowledged gap.** Restore rehearsal (SBX-035) runs into an isolated DR environment, never into staging.

## Capability mappings

CAP-051 directly; all 58 depend on deployment.

## Gate mappings

`G-PROD` — CAP-051 (SBX-035).

## Unresolved validation

- **Cloud provider and region: open.**
- **Data residency requirements: open.**
- **RPO / RTO: open.**
- Managed vs. self-managed PostgreSQL: open.
- Support model and on-call rotation: open.
- **Incident-response plan: open** ([14](../14-security-and-privacy.md) §10).
