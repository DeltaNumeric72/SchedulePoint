# ADR-0008 — Real-Time Picklist Transport

**Status:** `PROPOSED` — 2026-07-31. Not accepted. **Implements the product-owner-approved decision PO-DEC-18.**

> **REVISED 2026-08-01 (CAR-003).** **The winner constraint was insufficient.** The partial unique index on `(picklist_id, work_item_id)` prevents two claimants per item but **not one turn accepting two items**. The authoritative selection transaction, the three separate uniqueness invariants (**D-3a/D-3b/D-3c**), command idempotency, monotonic event sequencing, coordinator leases with fencing tokens, and correction/reopening are specified in [ADR-0023](ADR-0023-picklist-turn-transaction.md) and [SPEC-02](../specs/SPEC-02-picklist-turn-transaction.md).

## Context

Contradiction **C-04** recorded that the source product loads a real-time library, but **its actual use was never observed** — picklist execution was not witnessed in thirteen research phases. Separately, the source opened a connection on **every page load**, including pages with no live feature.

The picklist is the product's highest-concurrency surface. Two participants may attempt the same room simultaneously; a turn has a clock; a disconnected client must not lose its turn. Getting this wrong means someone is told they have a shift that someone else also has.

## Decision

**Server-authoritative WebSocket push for turn-critical picklist state. The client renders and sends commands; it is never authoritative.**

| Property | Design |
|---|---|
| **The clock** | `ends_at` is set and evaluated **server-side**. A client clock is display only |
| **Version tokens** | Every picklist and turn carries a `version`; clients echo it; stale commands are rejected |
| **Reconnection** | The client sends its last-known version; the server replies with a **full snapshot** if it is behind |
| **Visible staleness** | The UI always shows live / reconnecting / stale — **the user is never guessing** |
| **Explicit refresh fallback** | Always available; never the primary mechanism |
| **Page-scoped connections** | A connection opens **only** on a page with a live feature — never globally |
| **Administrative lists** | Ordinary request/refresh. Not everything needs to be live |
| **Tenant context** | Resolved at connect from the session, **never from a subscribe message** |

**The concurrency winner is decided by database uniqueness constraints — three of them, not one:** `UNIQUE (turn_id) WHERE accepted` (one result per turn), `UNIQUE (picklist_id, work_item_id) WHERE accepted` (one claimant per item), and `UNIQUE (picklist_id) WHERE state='open'` (one open turn). See [ADR-0023](ADR-0023-picklist-turn-transaction.md). **Persist, then broadcast**, always in that order.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Polling only** | Turn-critical state with a polling interval means a user acts on stale information. Also the amplification pattern the source exhibited |
| **Push everywhere, always** | Connections scaling with page views rather than with live features — the source's apparent behaviour, and pure waste |
| **Server-Sent Events** | One-directional; commands would need a separate path, splitting the ordering guarantees |
| **Client-authoritative timers** | A slow connection loses turns unfairly; a manipulated clock holds one indefinitely. Unacceptable in a system that decides who works |
| **Application-level locking for races** | Has a window, and is another thing that can be forgotten. **A constraint cannot be bypassed by a code path someone writes later** |

## Consequences

**Positive:** turn state is unambiguous · races are settled by the database · reconnection is a designed path rather than an accident · connection count scales with live usage.

**Negative:** the coordinator is a new process class with its own failure modes (RISK-04) · WebSocket infrastructure adds operational surface · message contracts must be versioned.

## Security implications

T-08 (real-time subscription leakage) is the central threat. Tenant context resolves at connect; **a subscribe outside the connection's tenant is denied and logged as a security event**. Every command carries an idempotency key so replay is a no-op.

## Operational implications

Coordinator restarts are survivable because **durable state is in PostgreSQL, not in the process**. Clients reconnect with backoff and jitter to avoid a thundering herd. Metrics: connections, reconnects, message latency, stale-client count. **A runbook for a coordinator restart during a live picklist is required and does not exist.**

## Capability mappings

CAP-031, CAP-032, CAP-033, CAP-030, CAP-034, CAP-060.

## Gate mappings

`G-ARCH` — CAP-032 (transport design). `G-PROD` — CAP-030..CAP-033, CAP-060. Tests: SBX-020..SBX-027, SBX-033.

## Unresolved validation

- **SBX-022 — simultaneous selection over ≥50 trials — has not been run. A single pass would not be evidence either.**
- Reconnection behaviour under real network conditions is untested.
- **The source's real-time behaviour remains `UNRESOLVED` and is not asserted anywhere in this design.**
- Whether a screen-reader user can complete a timed turn (SBX-033) is unverified.
