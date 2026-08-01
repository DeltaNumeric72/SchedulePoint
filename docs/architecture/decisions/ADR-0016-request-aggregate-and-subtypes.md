# ADR-0016 — Request Aggregate and Constrained Subtypes

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-011. **Implements the pending working default of PO-DEC-03 — which remains `pending`. This ADR is explicitly provisional.**

## Context

Requests come in five subtypes whose lifecycles genuinely differ: an availability request may be honoured without approval; a shift preference is non-binding and "unsatisfied" is a normal outcome rather than a denial; a no-call request is broader than time-off; vacation carries quota accounting and commitment to a schedule version. The previous schema used one `requests.status` and nullable subtype columns with no per-type constraint, so a shift-preference request could reach a terminal state with no shift type and a status whose meaning depended on a column the constraint did not check.

## Decision

**One Request aggregate root carrying only universally-common fields, five constrained subtype tables, and a linked but distinct Vacation lifecycle.** Each subtype table enforces its required and prohibited fields by database `CHECK`; each subtype has its own transition matrix; the universal `applied` status is replaced by `consumed_by_build`, `reflected_in_version`, and `unsatisfied`, which are three different facts. Vacation links to the root through `vacation_selections.request_id` and keeps its own states, quota predicates, and idempotent commit. Full design: [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **One overloaded nullable table** | The design CAR-011 identified as unsafe. **Explicitly not reinstatable** |
| **One universal status machine** | Cannot express that a shift preference is never approved and that `unsatisfied` is not a denial |
| **Five independent aggregates** | Duplicates withdrawal, deadline, approval, comment, audit, and idempotency logic five times; cross-type reporting becomes a union. **Remains the alternative if PO-DEC-03 is decided that way** ([SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md) §8) |
| **Vacation folded into the same table** | Quota accounting and version commitment are materially different and would re-create the overload

## Consequences

**Positive:** illegal subtype states are rejected by the database, not only by application code · the three meanings of "applied" become separately queryable · vacation gains one audit trail and one idempotency mechanism while keeping its own lifecycle · reversal exists, closing an irreversible operation.

**Negative:** six tables where there was one · a join to read a full request · **migration cost is high if PO-DEC-03 is later decided differently**, which is why the decision is flagged rather than assumed.

## Security implications

Request comments and reasons are `SENSITIVE-PII` and minimised in reports. The over-quota override path requires an explicit capability and a mandatory reason, so approving beyond capacity is an audited act rather than an unnoticed one.

## Operational implications

A deadline sweeper moves undecided past-deadline requests to `expired`. Weekend and holiday rolling is group configuration against an explicit holiday calendar, because "the deadline is Friday" is ambiguous when Friday is a holiday.

## Capability mappings

CAP-021, CAP-022, CAP-023.

## Gate mappings

`G-ARCH`, `G-BETA`, `G-PROD` — SBX-010, SBX-011, SBX-012, SBX-013. **None executed.**

## Unresolved validation

- **PO-DEC-03 is pending. This ADR implements its working default and is provisional.**
- PO-DEC-14 (default vacation mode) is pending.
- No test in [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md) §7 has been executed.
