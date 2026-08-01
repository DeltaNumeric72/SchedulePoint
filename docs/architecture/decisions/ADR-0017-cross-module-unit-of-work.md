# ADR-0017 — Cross-Module Unit of Work

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-017.

## Context

The proposal stated that a module never reads or writes another module's tables. The product's core transactions cannot obey it: publishing a schedule must atomically write versions, assignment snapshots, audit rows, idempotency records, and the outbox — nominally owned by four modules. Teams would have been forced to choose between direct cross-module writes and emitting events before commit. Both patterns would have appeared, producing a distributed monolith inside one process. Twenty-five modules over one schema made this worse.

## Decision

**Three write classes with one owning module per workflow.** W1 own-aggregate writes go through the module's own repository. **W2 in-transaction port calls** let the owning module of another aggregate enforce its invariants on the caller's unit of work — preserving ownership without a second transaction. W3 post-commit reactions go through the outbox. A normative table names the owner, W2 ports, and W3 effects for all thirteen state-changing workflows. **W2 port cycles are prohibited and checked in CI.** Six modules are merged (25 → 19) where two shared every invariant and every transaction. Full design: [SPEC-12](../specs/SPEC-12-cross-module-unit-of-work.md).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Strict ownership, no exceptions** | The status quo. Unimplementable for the product's own core transactions |
| **Free cross-module table access** | Ownership becomes meaningless; invariants scatter |
| **Event-driven between modules in-process** | Turns one transaction into several with no atomicity — the distributed-monolith outcome |
| **Merge everything into one module** | Loses the extraction seams that make notification delivery, the solver, and the coordinator replaceable

## Consequences

**Positive:** every workflow has one commit point · ownership survives · cross-module dependencies become explicit and reviewable in a port registry · fewer modules to reason about.

**Negative:** W2 is a real coupling and must be policed by CI, not by intention · the port registry is another artifact to maintain · merging modules is a boundary change that must be reflected in diagrams and traceability.

## Security implications

A W2 port enforces the owner's invariants, so a caller cannot bypass a security-relevant constraint by writing directly. The mandatory ordering `M-07 → M-08` on the import path is a W2 dependency with no alternative route, which is what makes the ingestion boundary unbypassable.

## Operational implications

Transaction sequence diagrams exist for the three highest-risk workflows and are asserted by test for all thirteen. A provider call attempted inside a transaction fails both a lint rule and a runtime guard.

## Capability mappings

CAP-014, CAP-019, CAP-023, CAP-026, CAP-027, CAP-031, CAP-040, CAP-046, CAP-055.

## Gate mappings

`G-ARCH`, `G-BETA`, `G-PROD`. **None passed.**

## Unresolved validation

- No transaction trace has been captured; U-01..U-07 are unexecuted.
- The merged module set changes [04](../04-domain-boundaries.md); the layering has been revised but not independently reviewed.
