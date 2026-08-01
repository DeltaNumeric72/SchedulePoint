# ADR-0003 — Database and Tenancy Strategy

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

> **REVISED 2026-08-01 (CAR-002).** **Connection-checkout tenant context is withdrawn as unsafe.** **Verified fact S-03b:** `SET LOCAL` lasts only to the end of the current transaction, while a plain `SET` persists for the session — so checkout-scoped context can survive an exception, a cancellation, or a pool hand-off. Tenant context is now **transaction-local**, established by a mandatory unit-of-work wrapper, with fail-closed behaviour outside it. See [ADR-0022](ADR-0022-request-scoped-tenant-context.md) and [SPEC-01](../specs/SPEC-01-request-context-and-tenant-isolation.md) §4.

## Context

SchedulePoint is multi-tenant: organizations contain groups, and a single person may hold memberships in several groups with **different roles in each**. A cross-tenant leak in a workforce system exposes staff rosters, contact details, and employment data. The research observed no tenant-isolation failure — but it also could not verify isolation, and absence of observation is not evidence of correctness.

## Decision

**A single PostgreSQL database with a shared schema, `organization_id` on every tenant table, and PostgreSQL row-level security with `FORCE ROW LEVEL SECURITY` as defence in depth.** Application-level tenant scoping is the primary control; RLS is the second layer that catches the query someone forgot to scope.

**Composite foreign keys carry `organization_id`** so a cross-tenant reference is rejected by the database, not merely unlikely. Every migration that adds a tenant table must add its RLS policy in the same migration (D-10), enforced in CI.

**Verified fact (S-03):** PostgreSQL RLS policies apply per-role and are bypassed by table owners and superusers unless `FORCE ROW LEVEL SECURITY` is set. **The application therefore connects as a non-owner role**, and the design depends on that.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Database per tenant** | Strongest isolation, but migrations across hundreds of databases, cross-tenant platform administration, and connection-pool pressure make it disproportionate at this stage. **Reconsider if a customer contract requires physical separation** |
| **Schema per tenant** | Similar migration burden with weaker benefit than database-per-tenant |
| **Shared schema, application scoping only** | One forgotten `WHERE` clause is a breach. The whole point of RLS here is that it does not depend on remembering |
| **RLS as the only control** | Puts authorization logic in policy definitions where it is hard to test and reason about, and makes every query's behaviour implicit |

## Consequences

**Positive:** one schema, one migration path · platform-wide queries remain possible · RLS turns a class of coding mistake into a non-event · composite FKs make cross-tenant references structurally impossible.

**Negative:** shared failure domain · **RLS has an unmeasured query cost (RISK-03)** · connection role management becomes load-bearing · noisy-neighbour effects are possible.

## Security implications

This ADR is the primary mitigation for T-01 (tenant isolation failure) and T-03 (IDOR). Opaque UUID keys mean an identifier alone reveals nothing and is useless without tenant context. **A test that asserts cross-tenant denial for every resource type is a build gate, not an optional suite.**

## Operational implications

Connection pooling must preserve tenant context correctly — a pooled connection carrying a previous tenant's context would defeat the design. Time-partitioning for audit and delivery-attempt tables as volume grows. Point-in-time recovery covers all tenants together.

## Capability mappings

CAP-001, CAP-002, CAP-003 directly; CAP-004, CAP-005, CAP-007, CAP-011..CAP-013, CAP-021, CAP-022, CAP-025, CAP-045 and every tenant-scoped capability indirectly.

## Gate mappings

`G-ARCH` — CAP-001, CAP-002. `G-PROD` — CAP-003 (SBX-004).

## Unresolved validation

- **RLS performance under realistic load is unmeasured** (assumption A-6).
- SBX-004 (cross-tenant denial) has not been executed.
- Connection-pool tenant-context handling is designed but unproven.
- No customer has yet stated a physical-separation requirement; if one does, this ADR is revisited.
