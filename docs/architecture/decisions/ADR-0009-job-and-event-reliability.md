# ADR-0009 — Job and Event Reliability

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

> **REVISED 2026-08-01 (CAR-010, CAR-017).** The outbox guarantees remain correct, but **the boundary of what they guarantee is now stated exactly**: domain state is exactly-once; **external delivery is at-least-once with a recorded ambiguity state** ([SPEC-07](../specs/SPEC-07-notification-delivery-contracts.md) §4). Cross-module transaction ownership is specified in [ADR-0017](ADR-0017-cross-module-unit-of-work.md).

## Context

Several operations must produce side effects that outlive the request: publishing a schedule notifies affected staff; posting an opportunity fans out; a picklist turn triggers an escalation ladder. Two failure modes are unacceptable:

- **The domain change commits and the notification is lost** — a shift changed and nobody was told.
- **The notification is sent and the domain change rolls back** — people were told about something that did not happen.

Publishing to a message broker inside a database transaction is not atomic with it, so a naïve broker publish produces exactly these two failures.

## Decision

**A transactional outbox.** The outbox row is written **inside the domain transaction**; a relay worker claims and dispatches it afterwards.

| Guarantee | Consequence |
|---|---|
| Domain change commits ⇒ the effect will be attempted | No lost notification |
| Domain change rolls back ⇒ no outbox row exists | No phantom notification |
| Dispatch fails ⇒ the domain change is unaffected | **A provider outage cannot roll back a published schedule** |
| Relay crashes mid-dispatch ⇒ retry | Idempotency keys prevent duplicates |

**Jobs carry references, not payloads.** A job holds a batch id or an aggregate id; the worker loads what it needs. **Every job is idempotent**, so an interrupted job is safely retried. Retries use bounded exponential backoff **with jitter**. Exhausted retries **dead-letter for inspection — never silent discard**. Queues are priority-separated so a bulk import cannot starve a picklist notification.

The queue is **PostgreSQL-backed initially** — which is what makes enqueue transactional with the domain write in the first place.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Direct broker publish in the transaction** | Not atomic with the transaction. This is the failure the ADR exists to prevent |
| **Send synchronously in the request** | A provider outage becomes a failed publication; latency becomes unbounded |
| **Dedicated broker from day one** | Solves the atomicity problem separately and immediately, for volume that does not yet exist. **The port stays open** (ADR-0001 extraction points) |
| **Fire-and-forget with retries in memory** | Loses everything on restart |

## Consequences

**Positive:** exactly the two unacceptable failures are structurally impossible · the domain module stays ignorant of delivery · replay is safe.

**Negative:** relay latency adds delivery delay · the outbox table needs pruning · **the PostgreSQL queue has a scaling ceiling (RISK-08)** that will require a broker eventually.

## Security implications

T-15 (queue poisoning): payloads are validated before enqueue, and **a worker refuses any job with no tenant context**. Ingestion payloads never travel in a job — only a batch reference ([12](../12-integrations-and-ingestion-privacy.md) §4.2).

## Operational implications

Metrics: queue depth, wait time, duration, failure rate, dead-letter growth. Alerts on depth, age, and dead-letter growth. **A dead-letter backlog runbook is required and does not exist.**

## Capability mappings

CAP-040 directly; CAP-014, CAP-018, CAP-024, CAP-027, CAP-046, CAP-055 depend on it.

## Gate mappings

`G-PROD` — CAP-040, CAP-051. Test: SBX-030a.

## Unresolved validation

- The PostgreSQL queue's actual throughput ceiling is unmeasured.
- Relay latency under load is unmeasured.
- No test has verified that running the relay twice does not double-send.
