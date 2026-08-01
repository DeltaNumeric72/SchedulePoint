# ADR-0016 — Request Aggregate and Constrained Subtypes

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-011. **Implements PO-DEC-03, which is `RESOLVED`. This ADR is no longer provisional.**

> **AMENDED 2026-08-01 (V-03) — status note.** This ADR previously read: *"Implements the pending working default of PO-DEC-03 — which remains `pending`. This ADR is explicitly provisional."* **PO-DEC-03 was resolved on 2026-08-01 under the product owner's delegated decision authority** ([docs/fable/21-decision-resolution.md](../../fable/21-decision-resolution.md); disposition in [remediation/internal-verification-corrections.md](../remediation/internal-verification-corrections.md) §0 V-03), adopting exactly the design this ADR records. The provisionality statement is therefore **withdrawn**.
> **The history is kept deliberately.** The design below was authored as a working default under a pending decision, and the sections that reason about the alternative are retained as such rather than deleted — the reversal analysis is real information about reversibility, and a resolution does not make the road not taken uninteresting. **What changed is the status, not the decision:** no table, constraint, transition, or trade-off recorded here is altered by the resolution.
> `PROPOSED` still means what it says: this ADR is **not accepted**, and the architecture as a whole remains proposed and not approved ([19](../19-risks-and-decisions.md) §3).

## Context

Requests come in five subtypes whose lifecycles genuinely differ: an availability request may be honoured without approval; a shift preference is non-binding and "unsatisfied" is a normal outcome rather than a denial; a no-call request is broader than time-off; vacation carries quota accounting and commitment to a schedule version. The previous schema used one `requests.status` and nullable subtype columns with no per-type constraint, so a shift-preference request could reach a terminal state with no shift type and a status whose meaning depended on a column the constraint did not check.

## Decision

**One Request aggregate root carrying only universally-common fields, five constrained subtype tables, and a linked but distinct Vacation lifecycle.** Each subtype table enforces its required and prohibited fields by database `CHECK`; each subtype has its own transition matrix; the universal `applied` status is replaced by `consumed_by_build`, `reflected_in_version`, and `unsatisfied`, which are three different facts. Vacation links to the root through `vacation_selections.request_id` and keeps its own states, quota predicates, and idempotent commit. Full design: [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **One overloaded nullable table** | The design CAR-011 identified as unsafe. **Explicitly not reinstatable** |
| **One universal status machine** | Cannot express that a shift preference is never approved and that `unsatisfied` is not a denial |
| **Five independent aggregates** | Duplicates withdrawal, deadline, approval, comment, audit, and idempotency logic five times; cross-type reporting becomes a union. *(amended 2026-08-01, V-03)* **Not adopted, and no longer a live branch** — PO-DEC-03 is resolved in favour of the single aggregate. Retained as **historical reversal analysis** in [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md) §8 |
| **Vacation folded into the same table** | Quota accounting and version commitment are materially different and would re-create the overload

## Consequences

**Positive:** illegal subtype states are rejected by the database, not only by application code · the three meanings of "applied" become separately queryable · vacation gains one audit trail and one idempotency mechanism while keeping its own lifecycle · reversal exists, closing an irreversible operation.

**Negative:** six tables where there was one · a join to read a full request · **migration cost would be high if this model were later abandoned** *(amended 2026-08-01, V-03 — PO-DEC-03 is resolved, so this is a statement about reversibility rather than about an open decision; that cost is precisely why the decision was surfaced for an explicit resolution rather than assumed)*.

## Security implications

Request comments and reasons are `SENSITIVE-PII` and minimised in reports. The over-quota override path requires an explicit capability and a mandatory reason, so approving beyond capacity is an audited act rather than an unnoticed one.

## Operational implications

A deadline sweeper moves undecided past-deadline requests to `expired`. Weekend and holiday rolling is group configuration against an explicit holiday calendar, because "the deadline is Friday" is ambiguous when Friday is a holiday.

## Capability mappings

CAP-021, CAP-022, CAP-023.

## Gate mappings

`G-ARCH`, `G-BETA`, `G-PROD` — SBX-010, SBX-011, SBX-012, SBX-013. **None executed.**

## Unresolved validation

- **PO-DEC-03 is `RESOLVED` (2026-08-01, delegated authority). This ADR is no longer provisional** *(amended 2026-08-01, V-03)*. The prior "pending / provisional" statement is withdrawn; see the status note at the head of this file. **The ADR itself remains `PROPOSED` and unaccepted** — a resolved product decision is not an accepted architecture decision, and conflating the two is what V-04 corrects in [19](../19-risks-and-decisions.md) §3.
- PO-DEC-14 (default vacation mode) is pending.
- No test in [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md) §7 has been executed.
