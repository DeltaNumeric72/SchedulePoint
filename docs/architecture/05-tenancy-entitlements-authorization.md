# 05 — Tenancy, Entitlements, and Authorization

**Status: `PROPOSED`.** Implements **PO-DEC-02** (authorization model) and **PO-DEC-04** (entitlement architecture), both **APPROVED**.

> **REVISED 2026-08-01 (CAR-001, CAR-002, CAR-008, CAR-021).** Four changes. **§4.1** — tenant context is now **client-declared and server-verified**, not resolved from a mutable session value. **§4.3** — connection-checkout RLS context is withdrawn as unsafe (**S-03b**) in favour of **transaction-local** context. **§§1, 3, 4.2, 4.4–4.6, 7** — the four layers gain a **normative truth table** with explicit-deny precedence and freshness. **§2.1** — Site reverts to the PO-DEC-01 pending default. Governing specs: [SPEC-01](specs/SPEC-01-request-context-and-tenant-isolation.md), [SPEC-06](specs/SPEC-06-authorization-truth-table.md).

---

## 1. The approved authorization model

```
organization entitlement → group/module availability → membership role → explicit action capability
```

Four layers, each answering a different question. **They are not interchangeable, and conflating any two of them reintroduces exactly the ambiguity that made C-02 unresolvable in the source product.**

| Layer | Question | Owned by | Failure mode if merged with another |
|---|---|---|---|
| **1 · Organization entitlement** | *Does this customer have this module?* | M-04 | Merging with role means enabling a module for a group silently grants every member administrative rights |
| **2 · Group/module availability** | *Is this group using it?* | M-04 | Merging with entitlement means a customer cannot pilot a module in one group |
| **3 · Membership role** | *What kind of user is this here?* | M-03 | Merging with capability means every new action needs a new role |
| **4 · Explicit action capability** | *May this person do this specific thing?* | M-03 | Merging with role loses granularity and produces untestable flags |

**Evaluation order is strict and short-circuits.** Layer 1 → 2 → 3 → 4. A denial at any layer stops evaluation and produces a generic denial.

### 1.1 Invariants

| # | Invariant |
|---|---|
| **A-1** | **Every action is authorized on the server.** Interface visibility reflects server authorization and never replaces it |
| **A-2** | **Deny-by-default.** An operation with no declared policy denies, and **fails its automated test** |
| **A-3** | **No permission flag may exist without a documented and tested capability difference.** A flag whose removal changes no test outcome does not ship |
| **A-4** | Permissions are scoped to organization and, where applicable, group |
| **A-5** | Database policies provide **additional** tenant isolation where practical — never the primary control |
| **A-6** | Entitlement is **not** a permission (§3) |

> **A-3 exists because of a specific observed failure.** The source product ships a `Picklist Admin` flag that demonstrably did not gate picklist administration. Whether that flag is vestigial, narrower than its name, or enforced elsewhere **remains unresolved and is not asserted here**. What we take from it is the rule, not a conclusion about the source.

---

## 2. Tenancy model

### 2.1 Entities

| Entity | Scope | Notes |
|---|---|---|
| **Organization** | Root | Billing entity and outermost security boundary |
| **Group** | Within org | The scheduling and permission scope |
| **Site** | — | **CHANGED (CAR-021). PO-DEC-01 is `pending` with a working default of "defer a first-class Site; model location as an attribute." A table with foreign keys is not neutral toward that decision, so `sites` is withdrawn and location carries a `site_label` attribute. The migration boundary in both directions is defined in [06](06-data-architecture.md) §3.2a. No site administration surface, API, or workflow is designed while the decision is pending** |
| **Department-equivalent** | — | **Deliberately not modelled.** Staff Group (M-06) already provides subsetting; adding a department entity without evidence of need would be speculative |
| **User account** | Org | `accountType`: person \| functional \| placeholder |
| **Organization membership** | Org | The user's relationship to the org |
| **Group membership** | Group | **Where role and capabilities live** |
| **Role** | Org or system | A named bundle of capabilities |
| **Capability** | — | The unit of authorization |
| **Entitlement** | Org | Module activation |
| **Group module availability** | Group | Per-group enablement of an entitled module |
| **Assignable placeholder** | Group | A schedulable slot with no person yet |
| **Functional account** | Org | Shared mailbox / desk; **audit entries must name it as non-person** |
| **Directory visibility** | Group policy | Explicit policy, never an emergent filter |

### 2.2 Tenant key placement

**Every tenant-scoped table carries `organization_id`.** Group-scoped tables additionally carry `group_id`.

This is deliberate denormalisation. The alternative — joining up a chain to reach the organization — makes RLS policies expensive and, worse, makes them *easy to get subtly wrong*. A direct column means every policy is a simple predicate.

**Composite foreign keys enforce consistency:** a row's `group_id` must belong to its `organization_id`. Enforced by a composite FK to `groups (organization_id, id)`, so a mismatched pair is rejected by the database rather than trusted from the application.

---

## 3. Entitlements — separate from permissions

**PO-DEC-04, approved.** Entitlements are **first-class organization-level records**.

### 3.1 Requirements met

| Requirement | Design |
|---|---|
| Organization-level module activation | `entitlements(organization_id, module_key, state, effective_from, effective_to)` |
| Group-level module availability | `group_module_availability(group_id, module_key, available)` |
| Module dependencies | `module_dependencies(module_key, depends_on_module_key)`, validated on activation |
| Effective dates | `effective_from` / `effective_to`; evaluation is time-aware |
| Audit history | Every grant, suspension, revocation, and dependency override audited |
| **Safe disabling** | Suspension hides surfaces; **no data is deleted or modified** |
| **Retained data** | Disabling is reversible; reactivation restores surfaces with data intact |
| Administrative inspection | Operators and org admins can see current and historical entitlement state |
| Commercial packaging without hard-coded pricing | **Modules are technical groupings.** No price, plan name, or tier appears in the schema |
| Connector-specific activation | Each connector is its own module key, depending on `hospital_integration` |
| Trial/evaluation states | `state ∈ {trial, active, suspended, revoked}` with `effective_to` driving expiry |

### 3.2 Proposed module structure

Technical grouping only — **commercial packaging remains a pending product decision (PO-DEC-04 commercial half).**

| Module key | Contains | Depends on |
|---|---|---|
| `core_scheduling` | Tenancy, identity, shift catalogue, rules, engine, publication, manual override, audit | — |
| `requests_vacation` | Requests, vacation modes, approvals, commit | `core_scheduling` |
| `marketplace` | Opportunities, offers, swaps, transfers | `core_scheduling` |
| `communications` | Directory, bulk messaging, group identity, all channels | `core_scheduling` |
| `reporting_documents` | Fairness statistics, reports, documents, calendar feeds | `core_scheduling` |
| `picklist` | Preparation, execution, paper and manual-entry modes, proxy, monitoring | `core_scheduling` |
| `hospital_integration` | Connector framework, ingestion boundary, integrated picklist mode | `picklist` |

**The last dependency is load-bearing:** integrated picklist mode is meaningless without the picklist module, so the dependency validator rejects that combination rather than producing a half-working feature.

### 3.3 The critical distinction

> **An entitlement says the organization *has* the module. A permission says this person *may act*.**
>
> Disabling an entitlement **hides a surface**. Revoking a permission **denies an action**. Neither ever deletes data.
>
> **All 58 capabilities exist in the completed product regardless of what any customer licenses.** Entitlement controls *activation*, never *existence*. A capability that only exists for some customers is not a capability — it is a fork.

---

## 4. Enforcement across every path

Authorization must hold on synchronous **and** asynchronous paths. A model that only works in request handlers is not a model.

### 4.1 Tenant context resolution

> **REPLACED (CAR-001).** The previous rule — one mutable `activeGroupId` on the session, with commands ignoring client context — prevented forgery but **caused silent retargeting**: a stale tab's legitimately-authorized command was executed against whatever group the session now pointed to.

**The client declares the tenant it believes it is addressing. The server verifies that declaration. It never substitutes its own current value.**

```
Request → immutable context tuple {
             principal_user_id            (from session)
             expected_organization_id     (CLIENT-DECLARED, SERVER-VERIFIED)
             expected_group_id            (CLIENT-DECLARED, SERVER-VERIFIED)
             membership_id                (derived server-side)
             context_version, session_epoch, authorization_version
          }
       → verify membership, freshness, and TARGET AGGREGATE BINDING
       → open unit of work; set TRANSACTION-LOCAL tenant settings
       → policy evaluation (SPEC-06 truth table)
       → handler
```

| Failure | Response |
|---|---|
| Forged or non-member tenant | `404` — indistinguishable from not-found |
| **Stale context version or session epoch** | **`409 CONTEXT_STALE`** — a recoverable interface condition, not an attack |
| **Target object in another tenant** | **`409 CONTEXT_TARGET_MISMATCH`, before any write** |

**No session-global active group exists, and no command handler reads one.** Full design: [SPEC-01](specs/SPEC-01-request-context-and-tenant-isolation.md) §§2–3.

### 4.2 Route-level policy declaration

Every route declares a required capability. A route without a declaration **fails the build** — not at runtime, at build time, so the failure is impossible to ignore.

```
route: POST /groups/:groupId/picklists/:id/start
  requires:
    entitlement: picklist
    groupAvailability: picklist
    capability: picklist.start
```

### 4.3 Database enforcement — and its documented limits

PostgreSQL row-level security is the second layer. **Documented facts (S-03) drive three hard constraints:**

| Documented fact | Consequence for us |
|---|---|
| RLS enabled + no policy ⇒ **default deny** | A new tenant table nobody wrote a policy for **fails closed**. We exploit this deliberately |
| **Table owners bypass RLS** unless `FORCE ROW LEVEL SECURITY` | The application role **must not own** tenant tables; migrations run as a **separate** role; `FORCE` is set on tenant tables |
| **Superusers and `BYPASSRLS` roles always bypass** | The application runtime role is **neither**. Non-negotiable |
| `TRUNCATE` and `REFERENCES` are **not** subject to RLS | Destructive operations are controlled by **grants**, not policies |

**Transaction-local context — REPLACES connection-checkout context (CAR-002).**

**Verified fact S-03b:** `SET LOCAL` "last[s] only till the end of the current transaction, whether committed or not"; a plain `SET` persists for the session; and `SET LOCAL` outside a transaction block warns and has no effect.

**Checkout-scoped context was therefore unsafe by construction** — an exception, a cancellation, a timeout, or a pool error could hand the next borrower a live tenant context. Every tenant statement now runs inside a unit-of-work wrapper that opens a transaction, sets `app.organization_id` and `app.group_id` via `set_config(..., true)`, **reads them back to verify**, and ends the transaction. **Outside that wrapper the settings are `NULL`, every policy predicate is false, and every tenant table returns zero rows and rejects every write — fail-closed, not fail-open.** **Statement-level connection pooling is prohibited** (TDG-03). Full design: [SPEC-01](specs/SPEC-01-request-context-and-tenant-isolation.md) §4.

**RLS is defence in depth.** If application authorization is correct, RLS never denies anything. Its value is that when application authorization is *wrong*, the blast radius is a failed query rather than another tenant's data.

### 4.4 Background jobs

Every job payload carries `organizationId`, `groupId`, and the **acting membership** (or an explicit system-actor marker). The worker **establishes the same tenant context** before executing. A job with no tenant context **refuses to run** rather than defaulting to anything.

### 4.5 Real-time connections

The WebSocket connection resolves tenant context **at connect time from the session**, not from a subscribe message. Subscriptions are authorized per topic against the resolved context. A subscribe request for a topic outside the connection's tenant is denied and logged as a security event.

### 4.6 Caches, storage, exports

| Path | Isolation |
|---|---|
| **Cache keys** | Prefixed `org:{id}:group:{id}:` — **structurally, via a key builder that cannot be bypassed** |
| **Object storage** | Key prefix `org/{id}/group/{id}/`; short-lived signed URLs; no public buckets |
| **Reports** | Generated with the requester's tenant context; artifact stored under the tenant prefix; access re-checked at download |
| **Exports** | Same as reports |
| **Audit events** | Organization-scoped, group-tagged; queries always tenant-filtered |
| **Connectors** | Each connection is org- and group-scoped; **routing is derived from the connection record, never from payload content** |

---

## 5. How each leakage class is prevented

| Leakage class | Prevention |
|---|---|
| **Cross-tenant object access** | Server-resolved context + capability policy + RLS + composite FK consistency |
| **Cross-tenant cache leakage** | Mandatory key prefixing via a builder; **no raw cache-key API is exposed** |
| **Job-context leakage** | Tenant context in the payload; worker refuses a context-free job; context cleared between jobs |
| **Report leakage** | Generated under requester context; access re-checked at download; artifacts stored per-tenant |
| **File leakage** | Per-tenant prefixes, signed short-lived URLs, purge invalidates URLs, no public access |
| **Notification leakage** | Recipients resolve **only** from the roster within the tenant; never free-text addresses |
| **Real-time subscription leakage** | Context at connect; per-topic authorization; cross-tenant subscribe denied and logged |
| **Connector routing errors** | Target group derived from the connection record; payload content **cannot** redirect a batch |

---

## 6. Support access and impersonation

| Control | Requirement |
|---|---|
| Distinct capability | Support access is its own capability, never bundled into an ordinary admin role |
| **Time-limited** | Expires automatically; no indefinite sessions |
| **Banner-visible** | The impersonated user's identity and the acting operator are always on screen |
| **Fully audited** | Session start/end **and every action**, with `onBehalfOf` naming the real actor |
| **Credential screens barred** | Impersonation cannot reach password, MFA, or token-management surfaces |
| Scoped | Per-organization, and per-group where applicable |

**Every audit entry written during impersonation names both parties.** An audit trail that attributes an operator's action to the impersonated user is worse than no trail — it actively misleads.

---

## 7. Policy-testing strategy

**Requirement: an unprotected operation must fail an automated check.** Four mechanisms, because one is not enough:

1. **Route-declaration completeness.** CI enumerates every route from the router and asserts each declares a policy. **An undeclared route fails the build.**
2. **Capability-difference test (A-3).** For every capability, a paired test proves an actor **with** it succeeds and an actor **without** it is denied. **A capability with no such pair fails CI** — this is what makes A-3 real rather than aspirational.
3. **Role × route matrix.** Generated from the route table and executed for every role including anonymous, asserting allow/deny per cell (SBX-001).
4. **Tenant-isolation sweep.** For every resource type, an actor in organization A attempts access to organization B's identifiers via UI and API; **100% denial required**, with "not found" indistinguishable from "not permitted" (SBX-004).

Plus a **migration/RLS pairing check**: a migration adding a tenant-scoped table without an RLS policy in the same migration fails CI.

---

## 8. Capability mapping

CAP-001, CAP-002, CAP-003, CAP-004, CAP-005, CAP-006, CAP-007, CAP-010, CAP-042, CAP-044, CAP-057.

**ADRs:** [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md), [ADR-0004](decisions/ADR-0004-authorization-architecture.md), [ADR-0005](decisions/ADR-0005-entitlement-architecture.md).

**Gates:** `G-ARCH` (design), `G-PROD` (verified by SBX-001, SBX-002, SBX-004).

---

## 9. What remains unproven

- **SBX-002** verifies the SchedulePoint four-layer model. It would additionally illuminate the source's behaviour, but **the source's `Picklist Admin` / `Pick List Access` semantics remain UNRESOLVED and are not asserted anywhere in this design.**
- **PO-DEC-01** (Site as a first-class entity) remains pending. **The schema now implements the pending default (attribute) rather than the unapproved alternative (entity)**, with both migration directions modelled in [06](06-data-architecture.md) §3.2a.
- **PO-DEC-06** (one user, multiple organizations) remains pending; the current model assumes one organization per user for the first release.
- **PO-DEC-09** (MFA/SSO scope) remains pending; the design assumes MFA is available and SSO is designed-for.
