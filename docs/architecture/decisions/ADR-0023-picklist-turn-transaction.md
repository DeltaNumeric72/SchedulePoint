# ADR-0023 — Picklist Turn Transaction and Coordinator Fencing

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-003.

## Context

The decisive picklist invariant was wrong. `D-3` claimed the partial unique index on `selections (picklist_id, work_item_id) WHERE accepted` meant "at most one work item claimed per picklist." **It guarantees at most one claimant per work item and nothing more.** One turn could accept two different work items and satisfy the index perfectly — which is exactly what happens when a physician and their proxy pick different rooms simultaneously.

Turn state, the timer, pause state, proxy authority, and the client's version were each described in prose, verified in separate steps, and not bound to the insert. No rule ordered events. Nothing prevented two coordinators or two timer sweepers from advancing the same list, so a reconnecting client could not determine which ordered history was authoritative.

## Decision

**One authoritative transaction per picklist command, serialised by a row lock on the picklist, with three separate database uniqueness invariants and monotonic event sequencing.**

- **D-3a — at most one accepted selection per turn:** `UNIQUE (turn_id) WHERE status = 'accepted'`. **This is the constraint that was missing.**
- **D-3b — at most one claimant per work item:** the previous index, correctly described.
- **D-3c — at most one open turn per picklist:** `UNIQUE (picklist_id) WHERE state = 'open'`.
- **D-11 command idempotency**, **D-12 gapless per-picklist event sequence**, **D-13 monotonic coordinator fencing token.**
- Every predicate — turn open, not expired by **server** clock, list active and not paused, actor authority, aggregate version, fencing token — is evaluated **inside** that transaction. **Persist, then broadcast**, always.
- Correction and reopening after completion are specified, retaining the superseded selection and producing a **new schedule version** rather than editing a published one.

Full design: [SPEC-02](../specs/SPEC-02-picklist-turn-transaction.md).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keep the single work-item index** | Does not express the invariant. The defect |
| **Application-level locking** | Has a window, and is another thing a future code path can forget |
| **Advisory lock instead of a row lock** | Works, but the row lock is already needed for the version check and gives the same serialisation without a second mechanism |
| **Distributed lock service** | A new dependency and a new failure mode to solve a problem one row lock solves |
| **Leader election for coordinators** | Heavier than needed. **A lease plus a fencing token in the database makes the database the arbiter**, which composes correctly with database failover |
| **Event sourcing the picklist** | Would give ordering for free but changes every read path for one aggregate |

## Consequences

**Positive:** the three-way physician/proxy/administrator race resolves to exactly one accepted outcome · a paused list cannot accept a selection after advancing · duplicate commands are no-ops · coordinators **relay** a single durable ordered log rather than generating events, so they cannot disagree · a partitioned coordinator's writes are rejected rather than merely discouraged.

**Negative:** the picklist row becomes a **logical single writer**, capping per-picklist throughput — acceptable, because a picklist is inherently one-at-a-time, and concurrency across different picklists is unaffected · the event log is another table to retain and prune · correction after completion is a genuinely more complex operation than the previous design admitted.

## Security implications

Authority is resolved inside the transaction against current state ([SPEC-06](../specs/SPEC-06-authorization-truth-table.md) §4), so a revoked capability cannot be used by a long-lived socket. `picked_by` and `acted_by` are always both recorded, so a proxy's or administrator's pick is never attributed solely to the participant. Every rejection is typed and audited; cross-tenant subscribe attempts are logged as security events.

## Operational implications

Coordinator restart is survivable: durable state is in PostgreSQL, a new lease is acquired with a higher token, and clients resynchronise from the event sequence. Metrics: turn durations, timeouts, skips, interventions, lease changes, and stale-token rejections. **Runbooks for a stalled picklist and for a coordinator restart during a live picklist are required and do not exist.**

## Capability mappings

CAP-030, CAP-031, CAP-032, CAP-033, CAP-034, CAP-060.

## Gate mappings

`G-ARCH`, `G-PROD` — SBX-020 through SBX-027, SBX-033. **None executed.**

## Unresolved validation

- **P-01..P-15 in [SPEC-02](../specs/SPEC-02-picklist-turn-transaction.md) §10 are unexecuted**, including the ≥50-trial same-item and different-item races.
- **Picklist execution was never observed in the source product across thirteen research phases.** Every lifecycle here is a SchedulePoint design, and the source's behaviour remains `UNRESOLVED`.
- Whether a screen-reader user can complete a timed turn (SBX-033) is unverified.
- PO-DEC-19 (default proxy scope) is pending.
