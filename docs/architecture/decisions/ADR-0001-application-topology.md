# ADR-0001 — Application Topology: Modular Monolith with Dedicated Workers

**Status:** `PROPOSED` — 2026-07-31. Not accepted. Supersedes nothing.

## Context

SchedulePoint must deliver 58 capabilities spanning four workload profiles that behave nothing alike: ordinary request/response web traffic, durable background jobs, **long-running CPU-bound solver runs**, and **long-lived real-time connections**. The team is small, no capability has been implemented, and no production traffic exists to learn from.

Two failure modes are equally real. Deploying everything as one process means a solver run consuming a core for minutes starves web requests. Starting with microservices means paying distributed-systems cost — network partitions, eventual consistency, distributed transactions, service discovery — to solve problems no measurement has demonstrated.

## Decision

**One codebase organised as a modular monolith with enforced internal boundaries, deployed as four independently scalable process classes:** web/API, background workers, scheduling workers, and a real-time coordinator.

Module boundaries are enforced in CI ([04](../04-domain-boundaries.md) §5), not by convention. Extraction points are identified in advance — notification delivery, the solver, and the real-time coordinator are the three most likely — and the design keeps each of them free of inbound domain dependencies so extraction stays cheap.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Single process, everything** | A solver run or a thousand WebSocket connections would degrade every request. The workload profiles are genuinely different, and pretending otherwise fails immediately |
| **Microservices from day one** | Distributed transactions across schedule publication, assignment creation, and notification enqueue — for a team with no production load to justify the cost. The transactional outbox (ADR-0009) becomes far harder |
| **Serverless functions** | Long-running solver runs and persistent real-time connections fit poorly; cold starts hurt turn-critical latency |
| **Monolith + one generic worker** | Collapses solver runs and notification dispatch into one queue, where a large build starves a picklist notification |

## Consequences

**Positive:** one deployment artifact and one test suite · transactional consistency where it matters · independent scaling of the four profiles · module boundaries preserve the option to extract later.

**Negative:** boundary erosion is a standing risk (RISK-06) and must be enforced mechanically · a shared database is a shared failure domain · one language and runtime for all four profiles constrains solver-integration choices.

**Neutral:** four process classes require four deployment definitions, but from one build.

## Security implications

A shared process boundary means module-level isolation is a code-discipline property, not a runtime one — **which is precisely why tenant isolation is enforced at the database with RLS (ADR-0003) rather than relying on module boundaries**. Workers refuse any job lacking tenant context.

## Operational implications

Four scaling dimensions, four health checks, four restart profiles. Workers must be idempotent so an interrupted job is safely retried; the real-time coordinator must hold no durable state so a restart is recoverable.

## Capability mappings

**All 58.** Topology is the substrate for every capability.

## Gate mappings

`G-ARCH` — topology must be settled before the first line of application code.

## Unresolved validation

- No load measurement exists to confirm the four-way split is the right granularity.
- The extraction cost of notification delivery is asserted, not demonstrated.
- **No independent architecture review has occurred.**
