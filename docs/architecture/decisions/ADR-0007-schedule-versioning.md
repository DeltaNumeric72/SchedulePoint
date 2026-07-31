# ADR-0007 — Schedule Versioning and Publication

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

## Context

A published schedule is an operational commitment: people arrange childcare, travel, and second jobs around it. Once published, "what did the schedule say on the 4th, and who changed it?" must be answerable months later.

The research also recorded an irreversible operation in the source product: committing vacation selections to a schedule was a **one-way transfer** with no documented undo. An irreversible operation on a load-bearing artifact is a defect, not a feature.

## Decision

**Schedules are immutable, versioned artifacts. Publication creates a new version; it never mutates a published one.**

- Each version records its predecessor, publisher, timestamp, and reason.
- **Supersession never deletes.** A superseded version stays readable exactly as it was.
- **Reverting publishes forward** — a new version whose content matches an earlier one — rather than rolling back. History remains a straight line, and the revert itself is a recorded act.
- Publication is a single transaction: create the version, materialise assignments, write audit entries, enqueue notifications via the outbox (ADR-0009). **If any part fails, nothing is published.**
- Amendments after publication create a new version and notify affected memberships.
- **Circulated partial schedules are visibly distinguishable from published ones** — a scheduler sharing a draft must not have it mistaken for a commitment.
- Ten distinct concepts (period, demand, draft, build, version, publication, circulation, amendment, revert, supersession) are kept separate; conflating any two loses an answer someone will need.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Mutable schedule + audit log** | The audit log becomes the only record of what the schedule *was*, and reconstructing a past state from a diff stream is unreliable exactly when it matters |
| **Rollback by deleting versions** | Destroys the record of the mistake. **The mistake is part of the history** |
| **Event sourcing the whole schedule** | Powerful, but every read becomes a projection and the operational complexity is disproportionate. Versioned snapshots give the needed properties far more simply |
| **Copy-on-write per assignment** | Loses the atomic notion of "the schedule as published on this date" |

## Consequences

**Positive:** any past state is directly readable · every change is attributable · vacation commit becomes reversible, closing the observed defect · notification fan-out has an unambiguous trigger.

**Negative:** storage grows with each version (RISK-09; mitigated by partitioning, never by deletion) · queries must be version-aware · a large publication is a large transaction and must be measured.

## Security implications

Version history is effectively an audit surface and inherits its constraint: **no clinical content, no patient data**. Publishing requires a capability distinct from editing — being able to draft is not being able to commit.

## Operational implications

Publication latency scales with schedule size and must be benchmarked. Concurrent publication attempts on the same period resolve by optimistic concurrency: **first wins, the second gets an explicit conflict rather than a silent overwrite**.

## Capability mappings

CAP-014, CAP-018, CAP-019, CAP-020, CAP-023, CAP-026, CAP-049, CAP-059, CAP-017.

## Gate mappings

`G-BETA` — CAP-019, CAP-023, CAP-026. `G-PROD` — CAP-014, CAP-018, CAP-020, CAP-049, CAP-059.

## Unresolved validation

- Publication transaction latency at scale is unmeasured.
- Amendment granularity is defined in [07](../07-schedule-and-publication.md) §4 but unvalidated with users.
- No test has verified that revert-by-forward-publication is understandable to schedulers.
