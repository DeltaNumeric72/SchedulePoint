# ADR-0022 — Request-Scoped Tenant Context and Transaction-Local RLS

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-001 and CAR-002.

## Context

**Two independent isolation defects.**

**CAR-001.** The session held one mutable `organizationId`/`activeGroupId`, and commands deliberately ignored client-supplied context to prevent forgery. A session is shared across tabs, so a stale tab's legitimately-authorized command was silently retargeted at whatever group the session now pointed to. The authoritative `QA-TEN-004` outcome requires that a context switch be *detected*, never silently substituted.

**CAR-002.** The RLS tenant variable was set on connection checkout and cleared on release — session state. **Verified fact S-03b:** a plain `SET` persists to the end of the session, while `SET LOCAL` "last[s] only till the end of the current transaction, whether committed or not," and issuing `SET LOCAL` outside a transaction block "emits a warning and otherwise has no effect." A missed reset, exception, cancellation, or pool error could hand the next borrower a live tenant context.

## Decision

**Two changes, together.**

**(1) Context is an immutable request-scoped tuple in which the client *declares* the tenant it believes it is addressing and the server *verifies* that declaration** — against membership, against a context version, and **against the target aggregate** — **rejecting a mismatch rather than substituting the current session value.** No session-global active group exists; nothing reads one.

**(2) Every tenant statement executes inside a unit-of-work wrapper that opens a transaction, sets `app.organization_id` and `app.group_id` with `set_config(..., true)`, reads them back to verify, and ends the transaction.** RLS policies read those settings, so **outside the wrapper every tenant table returns zero rows and rejects every write.** Application and worker roles are non-owner, non-superuser, non-`BYPASSRLS`, with `FORCE ROW LEVEL SECURITY` on every tenant table. **Statement-level connection pooling is prohibited.**

Full design: [SPEC-01](../specs/SPEC-01-request-context-and-tenant-isolation.md).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keep session-global active group** | The confused-deputy defect |
| **Never accept a client tenant identifier** | Prevents forgery but *causes* silent retargeting. **Verification, not refusal, is the correct inversion** |
| **Tab-scoped sessions** | Multiplies session state and still does not bind a command to its target aggregate |
| **Connection-checkout RLS context** | Unsafe by construction (S-03b) |
| **Clear context in a `finally` block** | A cleanup step that can be forgotten, skipped by a hard failure, or bypassed by a code path that never ran the setter |
| **Application-only scoping, no RLS** | One forgotten `WHERE` clause is a breach |

## Consequences

**Positive:** a stale tab fails loudly with a distinct recoverable status instead of writing to the wrong group · forgetting the wrapper **fails closed with zero rows**, which is loud in development rather than silent in production · transaction-local settings cannot outlive the work they scope, so there is no cleanup step to miss.

**Negative:** every request must carry and echo context, which touches every client surface · the read-back verification is an extra round trip per unit of work · **the pooler configuration becomes a correctness dependency, not a performance choice** · `409 CONTEXT_STALE` is a new user-visible condition the interface must handle well rather than as a generic error.

## Security implications

Primary mitigation for T-01 (tenant isolation failure), T-02 (authorization bypass), and T-03 (IDOR). Forged context still returns `404` with no distinction between "does not exist" and "not permitted"; stale context returns `409` because it is a recoverable interface condition, not an attack. Support access runs under RLS with an explicit tenant context and every read audited; break-glass is two-person, time-boxed, alerted, and recorded.

## Operational implications

Five database roles with distinct grants (`app_migrator`, `app_runtime`, `app_worker`, `app_readonly_support`, `app_breakglass`). Maintenance jobs that iterate tenants open **one unit of work per tenant** and never run unscoped. A CI grep forbids non-`LOCAL` tenant settings anywhere in the codebase.

## Capability mappings

CAP-001, CAP-002, CAP-003, CAP-006, CAP-014, CAP-019, CAP-031, CAP-032, and every tenant-scoped capability.

## Gate mappings

`G-ARCH`, `G-BETA`, `G-PROD` — SBX-004 extended. **Not executed.**

## Unresolved validation

- **T-01..T-15 in [SPEC-01](../specs/SPEC-01-request-context-and-tenant-isolation.md) §7 are unexecuted. They are scheduled at the schema/prototype stage, before feature work.**
- **RLS performance under realistic load remains unmeasured** (assumption A-6).
- TDG-02 and TDG-03 must confirm the chosen data-access layer and pooler can honour transaction-local context.
- PO-DEC-06 (one user across multiple organizations) is pending; it would vary `expected_organization_id` without changing the mechanism.
