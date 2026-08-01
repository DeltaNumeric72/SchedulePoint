# SPEC-01 — Request Context and Tenant Isolation

**Status: `PROPOSED`.** Remediates **CAR-001** (Critical) and **CAR-002** (Critical).
**Supersedes:** [05](../05-tenancy-entitlements-authorization.md) §4.1 and §4.3 "Connection discipline"; [01](../01-architecture-overview.md) invariant I-01 as previously worded.
**New invariants:** **I-14**, **I-15**. **ADR:** [ADR-0022](../decisions/ADR-0022-request-scoped-tenant-context.md).

> **What was wrong.** The previous design stored one mutable `activeGroupId` on the session and resolved every command against "the current session selection." That is a confused deputy: a stale tab submits a legitimately-authorized command and the server silently retargets it at whatever group the session now points to. Separately, the RLS tenant variable was set **on connection checkout** — session-scoped state that survives an exception, a cancellation, or a pool hand-off.

---

## 1. The two defects, stated precisely

| | CAR-001 | CAR-002 |
|---|---|---|
| **Broken assumption** | "The session knows which group the user means" | "Connection checkout is a reliable place to set tenant state" |
| **Why it fails** | A session is shared by every tab; the newest selection wins | `SET` persists for the session; `SET LOCAL` does not (verified: S-03b) |
| **Worst outcome** | A schedule is published, or a clinical work item allocated, in the **wrong group** | A query reads or writes **another organization's rows** |
| **Fix** | Immutable request-scoped context tuple, validated against the target aggregate | One unit-of-work wrapper; transaction-local settings; no tenant access outside it |

---

## 2. The context tuple (CAR-001)

### 2.1 Definition

> **AMENDED 2026-08-01 (V-06, V-08)** — two corrections from the internal verification ([rationale](../remediation/internal-verification-corrections.md) §2):
> 1. **Action scope is declared.** Every route and every command declares its scope as either **`group`** or **`organization`**. `expected_group_id` is **required for group-scoped actions and nullable for organization-scoped actions**. The organization-scoped action set is **enumerated in [SPEC-06](SPEC-06-authorization-truth-table.md)** (§1/§2, per V-24) — it is not open-ended, and an action absent from that enumeration is group-scoped by default.
> 2. **`context_version` is no longer defined here.** [SPEC-06](SPEC-06-authorization-truth-table.md) §4's counters are the single source of the definition; the divergent list previously given in this table is withdrawn.

**Context is an immutable value constructed once per request, job, or socket command, and never mutated thereafter.**

| Field | Source | Purpose |
|---|---|---|
| `principal_user_id` | Session (server-side) | Who is acting |
| `action_scope` | Declared by the route/command definition: `group` \| `organization` *(added 2026-08-01, V-06)* | Selects which validation branch §2.3 runs |
| `expected_organization_id` | **Client-declared, server-verified** | What the caller *believed* it was acting on |
| `expected_group_id?` | **Client-declared, server-verified.** Required when `action_scope = group`; **null when `action_scope = organization`** *(amended 2026-08-01, V-06)* | Same, at group scope |
| `membership_id` | Derived server-side. `action_scope = group` → from `(principal_user_id, expected_group_id)`. `action_scope = organization` → from `(principal_user_id, expected_organization_id)`, resolving the **organization membership** *(amended 2026-08-01, V-06)* | The acting membership |
| `context_version` | **Defined by [SPEC-06](SPEC-06-authorization-truth-table.md) §4** — `membership_set_version`, `organization_version`, and `group_version` as that section defines them. This spec states no independent list *(amended 2026-08-01, V-08)* | Freshness |
| `session_epoch` | Bumped on privilege change, impersonation start/end, and re-authentication | Session freshness |
| `authorization_version` | Hash of the resolved policy inputs (see [SPEC-06](SPEC-06-authorization-truth-table.md)) | Cache validity |
| `correlation_id` | Generated at the edge | Traceability |
| `on_behalf_of_membership_id?` | Impersonation or proxy | Attribution |

**Staff availability is *not* a context-version input** *(amended 2026-08-01, V-08)*. Availability is a routine, high-frequency, self-service edit that changes no privilege; bumping a freshness counter on it would make `409 CONTEXT_STALE` a routine occurrence and train both users and implementers to engineer around it. Only the privilege-bearing changes enumerated in [SPEC-06](SPEC-06-authorization-truth-table.md) §4 bump a counter.

**`expected_*` is declared by the client and *verified*, not *trusted*.** This is the inversion that fixes CAR-001. The old rule — "never accept a client tenant identifier" — prevented forgery but *caused* silent retargeting. The correct rule is:

> **I-14 — The client declares which tenant it believes it is addressing. The server verifies that declaration against server-side membership and against the target aggregate, and rejects a mismatch. It never substitutes its own current value.**

A forged `expected_group_id` fails membership verification exactly as before. A **stale** one now fails too, instead of being silently replaced.

### 2.2 Where the declaration comes from

| Surface | Carrier |
|---|---|
| HTML form / page | Hidden field rendered at page load, plus the path segment |
| JSON API | Path segment `/organizations/{org}/groups/{group}/…` for group-scoped actions, `/organizations/{org}/…` for organization-scoped ones *(amended 2026-08-01, V-06)*, **and** an `X-SchedulePoint-Context` header carrying `context_version` and `session_epoch` |
| WebSocket | Bound at connect **and** re-declared on **every command frame** (§5) |
| Background job | Frozen into the job payload at enqueue (§6) |

**The path segment is not sufficient on its own** — it identifies the tenant but not the freshness. Both are required.

### 2.3 Validation sequence

> **AMENDED 2026-08-01 (V-06, V-07)** — steps 2/3 gain an organization-scope branch, and step 6 no longer discloses cross-tenant existence to an unauthorized actor ([rationale](../remediation/internal-verification-corrections.md) §2).

Executed in order; the first failure aborts **before any write and before any event**:

| # | Check | Failure response |
|---|---|---|
| 1 | `expected_organization_id` exists and is active | `404` — indistinguishable from not-permitted |
| 2 | **`action_scope = group`:** a **group membership** exists for `(principal_user_id, expected_group_id)` and is `active`. **`action_scope = organization`:** an **organization membership** exists for `(principal_user_id, expected_organization_id)`, is `active`, and carries an **organization role** *(amended 2026-08-01, V-06)* | `404` |
| 3 | **`action_scope = group`:** `expected_group_id` is non-null and belongs to `expected_organization_id`. **`action_scope = organization`:** `expected_group_id` is null *(amended 2026-08-01, V-06)* | `404` |
| 4 | `context_version` matches the counters defined in [SPEC-06](SPEC-06-authorization-truth-table.md) §4 *(amended 2026-08-01, V-08)* | **`409 CONTEXT_STALE`** with a re-fetch directive |
| 5 | `session_epoch` matches | **`409 SESSION_STALE`** — forces re-authentication of context |
| 6 | **Target aggregate binding** (§3) | **`409 CONTEXT_TARGET_MISMATCH` only when the actor is authorized for this action in their declared tenant; otherwise `404`** *(amended 2026-08-01, V-07)* |
| 7 | Authorization ([SPEC-06](SPEC-06-authorization-truth-table.md)) | `403` or `404` per policy |

**Steps 4–6 are the CAR-001 remediation.** Steps 1–3 existed before and were never the problem.

**Step 6, stated precisely** *(added 2026-08-01, V-07)*. When the named target resolves to a tenant other than the declared one, the response depends on whether the actor could legitimately have performed this action at all in the tenant they declared:

| Actor is authorized for this action in the **declared** tenant | Response |
|---|---|
| Yes | **`409 CONTEXT_TARGET_MISMATCH`** — a genuine stale-tab condition, and the client can recover from it |
| No | **`404`** — identical to "does not exist". No cross-tenant existence is disclosed |

The authorization test for this branch is the ordinary [SPEC-06](SPEC-06-authorization-truth-table.md) capability evaluation for the declared tenant, evaluated **without** the object-policy layer (which is exactly SPEC-06's L5.1 and cannot run against an object in another tenant). This is why SPEC-06 places tenant binding at **L5.1, after L4** and not before it.

### 2.4 Distinguishing stale from forbidden

A stale context is a **recoverable user-interface condition**, not an attack. It returns a distinct status so the client can say "this tab is showing Group A but you have switched to Group B — reload or switch back," rather than failing mysteriously or, worse, succeeding against the wrong group.

**Forgery and cross-tenant probing still return `404`** with no distinction between "does not exist" and "not permitted." *(amended 2026-08-01, V-07)* This is consistent with step 6 above rather than in tension with it: `409 CONTEXT_TARGET_MISMATCH` is reachable **only** by an actor who holds the capability for the action in the tenant they declared. An actor probing with a UUID from a tenant they hold no capability in — a departed member, a leaked report, a shared URL — receives `404` and learns nothing.

---

## 3. Target aggregate binding

**Every command that names an object must prove the object lives in the declared tenant — before the command runs, not as a side effect of a query filter.**

```
resolve(target_id) → { organization_id, group_id, aggregate_type, aggregate_version }
assert target.organization_id == ctx.expected_organization_id
if ctx.action_scope == 'group':                                    -- amended 2026-08-01, V-06
    assert target.group_id    == ctx.expected_group_id
assert target.aggregate_type  == the type this route operates on
-- on any assertion failure, respond per §2.3 step 6:
--   409 CONTEXT_TARGET_MISMATCH if authorized in the declared tenant, else 404  (V-07)
```

| Property | Rule |
|---|---|
| **Identifiers are globally unique** | UUIDs. An identifier from Group A is *resolvable* but never *usable* under Group B's context |
| **Resolution happens inside the unit of work** | So RLS applies to the resolution query itself |
| **`aggregate_version` is echoed by the client** where the command mutates an aggregate | Optimistic concurrency, and a second stale-state signal |
| **Failure is `409`, not a silent no-op** | A silent no-op is how "nothing happened" gets mistaken for "it worked" |

**Worked example — the CAR-001 scenario:**

1. Tab 1 opens a manual-assignment form for Group A. The form carries `expected_group_id = A`, `context_version = 7`.
2. Tab 2 switches to Group B. The membership-set version is unchanged (7) — switching groups is not a privilege change — but the *session's* notion of "active group" no longer matters, because **nothing reads it**.
3. Tab 1 submits. Context declares Group A. Membership in A is verified. The target `schedule_version` resolves to Group A. **The command executes against Group A, which is what the user actually saw.**
4. If instead the user's Group A membership had been **revoked** between steps 1 and 3, the membership-set version would have advanced to 8, step 4 returns `409 CONTEXT_STALE`, and nothing is written.

**Neither outcome is "silently act on Group B."** That path no longer exists, because no code reads a session-global active group.

### 3.1 What remains of session state

The session stores `principal_user_id`, `session_epoch`, and authentication facts. **It stores no active organization and no active group.** A "current group" exists only as a **client-side navigation preference** that seeds the next page's declared context — it is never authoritative and is never read by a command handler.

---

## 4. The unit of work and transaction-local RLS (CAR-002)

### 4.1 Verified fact

**S-03b (PostgreSQL `SET` / `SET LOCAL`):** `SET LOCAL` takes effect for the remainder of the **current transaction** only; a plain `SET` persists for the **session**. `set_config(name, value, true)` is the function form of `SET LOCAL`. See [references](../references/official-technical-sources.md).

**Consequence:** connection-checkout context is unsafe by construction. Transaction-local context is the only primitive whose lifetime is bounded by the work it protects.

### 4.2 The wrapper

**I-15 — No statement may touch a tenant-scoped table outside a unit of work that has already established transaction-local tenant context.**

```
withUnitOfWork(ctx, fn):
    acquire connection from pool
    BEGIN
    SELECT set_config('app.organization_id', ctx.expected_organization_id, true)   -- LOCAL
    SELECT set_config('app.group_id',        ctx.expected_group_id,        true)   -- LOCAL
    SELECT set_config('app.membership_id',   ctx.membership_id,            true)   -- LOCAL
    SELECT set_config('app.correlation_id',  ctx.correlation_id,           true)   -- LOCAL
    verify: read back ALL FOUR settings and compare each to its expected value  -- read-back
            -- (amended 2026-08-01, EV-M0-SPA T-14b: a single-setting read-back passes when only
            --  app.group_id is lost, reproducing the CAR-001 defect class below the application)
    on read-back mismatch:                       -- amended 2026-08-01, V-10
        ROLLBACK
        mark the connection POISONED and discard it from the pool (never return it)
        raise CONTEXT_READBACK_MISMATCH to the caller
        emit an operational alert at page severity (TDG-02 / TDG-03 failure mode)
    result := fn(tx)
    COMMIT   -- settings expire with the transaction, by definition
  on any error:
    ROLLBACK -- settings expire with the transaction, by definition
  finally:
    release connection
```

| Property | Why it closes CAR-002 |
|---|---|
| **Settings are transaction-local** | An exception, a cancellation, a statement timeout, or a lost connection **cannot** leave them set. There is no cleanup step to forget |
| **Read-back verification** | Catches a misconfigured pooler that silently discards `SET LOCAL`. **A mismatch is not advisory** *(amended 2026-08-01, V-10)*: the transaction **aborts**, the connection is **discarded from the pool** rather than returned to it, and an **operational alert** is raised. All three are asserted by T-14. Logging and continuing is explicitly prohibited — this read-back is the single detector for the TDG-02/TDG-03 failure mode the whole design rests on |
| **No nested transaction may change tenant** | A nested `withUnitOfWork` with a *different* tenant is a programming error and **throws**. Savepoints are permitted; re-tenanting is not |
| **`SET` (session form) is prohibited** | A lint rule and a CI grep forbid non-`LOCAL` tenant settings anywhere in the codebase |
| **Pool mode constraint** | The connection pooler **must** operate in session or transaction mode with transaction affinity. **Statement-level pooling is incompatible with this design and is prohibited** ([SPEC-15](SPEC-15-technology-decision-gates.md) TDG-03) |

### 4.3 Denying access outside the wrapper

> **AMENDED 2026-08-01 (V-09)** — organization-only predicates gave the database no defence in depth at *group* scope, which is precisely the scope CAR-001 is about. Group-scoped tables now carry a **group predicate in addition to** the organization predicate ([rationale](../remediation/internal-verification-corrections.md) §2).

Belt and braces, because a wrapper you can forget is a wrapper that will be forgotten:

| Mechanism | Effect |
|---|---|
| **RLS policies read `nullif(current_setting('app.organization_id', true), '')::uuid`** *(normative spelling amended 2026-08-01 — EV-M0-SPA X-09: `SET LOCAL` reverts the value but does not undefine the GUC, so a REUSED pooled connection reads `''`, not `NULL`; the naive `::uuid` cast then raises 22P02 on every query instead of returning zero rows)* | Outside a unit of work the setting is `NULL` (pristine connection) **or `''` (reused connection — the production steady state)**; with the `nullif` spelling the predicate is false in both cases, and **every tenant table returns zero rows and rejects every write** |
| **Group-scoped tables additionally read `current_setting('app.group_id', true)`** *(added 2026-08-01, V-09)* | A table carrying `group_id` has the conjunctive predicate `organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND group_id = nullif(current_setting('app.group_id', true), '')::uuid`. An application bug that resolves the **wrong group within the right organization** — the CAR-001 defect class — is then caught below the application layer, not only above it. `app.group_id` is `NULL` under an organization-scoped unit of work, so group-scoped tables are fail-closed there too |
| **`FORCE ROW LEVEL SECURITY`** on every tenant table | The owner bypass does not apply to the application role even if ownership is misconfigured |
| **Non-owner application role** | `app_runtime` owns nothing, is not superuser, and does not hold `BYPASSRLS` |
| **Non-owner worker role** | `app_worker` — same constraints, separate credentials, separate grants |
| **Migration role** | `app_migrator` owns the schema, runs only migrations, and is **never** used by a running process |
| **Repository lint** | Raw client access outside the repository layer fails the build |

**Fail-closed is the important half.** Forgetting the wrapper does not produce a leak; it produces zero rows — a loud, immediate, obviously-broken failure in development.

**Declared cross-group policy exceptions** *(added 2026-08-01, V-09)*. A conjunctive group predicate would otherwise break legitimate organization-wide reads. Those reads go through **named, enumerated policy exceptions** — never through relaxing the default predicate — and each exception is a policy on a specific table, permitting `SELECT` only, when `app.group_id` is `NULL` **and** the acting membership holds the corresponding cross-group capability from [SPEC-06](SPEC-06-authorization-truth-table.md) §3:

| Exception | Tables | Grants | Gated on |
|---|---|---|---|
| `EX-1 org-wide dashboard` | Read-model/reporting tables carrying `group_id` | `SELECT` | Organization-scoped context (`app.group_id IS NULL`) + a cross-group read capability |
| `EX-2 organization administration` | `groups`, `memberships`, `role_capabilities` | `SELECT` | Organization membership with an organization role (§2.3 step 2, org branch) |
| `EX-3 entitlement administration` | Entitlement and module-availability tables | `SELECT`, and `INSERT`/`UPDATE` on entitlement rows only | Organization-scoped context + entitlement-administration capability |
| `EX-4 cross-group transfers and marketplace` | `transfers`, `shift_offers`, `shift_swaps` | `SELECT` on the counterparty group's row | Both groups in the same organization + the transfer/marketplace capability in each |

**The list is closed.** A cross-group read that is not one of these is a defect, not a configuration change; adding an exception is a change to this section and to SPEC-06 §3, reviewed as such.

> **AMENDED 2026-08-01 — executed-spike evidence (EV-M0-SPA), three additional §4 requirements.**
> **(a) Referential-integrity tenant binding:** FK checks bypass RLS (X-06: a single-column FK accepted a cross-tenant reference). Every tenant table therefore carries `UNIQUE (id, organization_id, group_id)`, and every FK between tenant tables is composite over the tenant columns, so a reference cannot cross a tenant boundary regardless of RLS.
> **(b) Unique-constraint existence oracle:** PK/unique checks also bypass RLS (X-11: inserting an id that exists only in another org raises 23505, disclosing existence of an invisible row). Unique keys on tenant tables are tenant-qualified wherever a caller can choose the key value, and 23505 is translated to a generic error at the edge.
> **(c) Pooler-mode startup assertion:** the per-transaction read-back is a detector, not a proof, against statement-level routing; each process asserts transaction affinity at startup (two-statement probe equivalent to X-02) and refuses traffic on failure. The lint banning every `SET`-statement form of a tenant setting (`SET`/`SET SESSION`/`SET LOCAL app.*`; only `set_config(name, value, true)` permitted) is a CI gate.

### 4.4 Role matrix

| Role | Owns schema | `BYPASSRLS` | Superuser | Used by | Tenant tables |
|---|:--:|:--:|:--:|---|---|
| `app_migrator` | **yes** | no | no | Migrations only, in CI/CD | Full DDL; **no application traffic** |
| `app_runtime` | no | **no** | **no** | Web/API processes | DML **only under RLS** |
| `app_worker` | no | **no** | **no** | Background, scheduling, real-time processes | DML **only under RLS** |
| `app_readonly_support` | no | **no** | **no** | Support tooling (§4.5) | `SELECT` only, under RLS, **every read audited** |
| `app_breakglass` | no | yes | no | **Two-person emergency only** (§4.5) | **Every session audited and alerted** |

### 4.5 Privileged and support boundaries

| Path | Control |
|---|---|
| **Support read access** | `app_readonly_support` operates **under RLS with an explicitly set tenant context**, so support sees one tenant at a time. Every statement is audited with the operator's identity and the ticket reference |
| **Cross-tenant platform queries** | Permitted only for aggregate, non-row-level metrics through defined views that expose counts, never rows |
| **Break-glass** | `app_breakglass` requires **two-person authorization**, is time-boxed, raises an immediate alert, and its session is recorded. It exists because refusing to plan for emergencies produces undocumented emergency access, not the absence of it |
| **Maintenance jobs** | Run per-tenant under `app_worker` with explicit context. **A maintenance job that iterates tenants opens one unit of work per tenant** — it never runs unscoped |
| **`TRUNCATE` / `REFERENCES`** | Not subject to RLS (S-03). Controlled by withholding the grants from every runtime role |

---

## 5. WebSocket command binding

**A connection is not a context.** Privileges change during long-lived connections, which is precisely the CAR-008 defect; binding context once at connect repeats it.

| Rule | Detail |
|---|---|
| **Connect** | Establishes `principal_user_id` and `session_epoch` from the session cookie. **Origin is verified** ([SPEC-11](SPEC-11-audit-assurance-and-security-boundaries.md) §4.1) |
| **Every command frame** | Carries `expected_organization_id`, `expected_group_id`, `context_version`, `session_epoch`, `aggregate_version`, and a `command_id` |
| **Every command frame** | Runs the full §2.3 validation sequence and the full authorization evaluation **against current state** |
| **Stale frame** | Rejected with `CONTEXT_STALE`; the client resynchronises. **Never silently retargeted** |
| **Privilege change** | Bumps `context_version`; in-flight and subsequent frames fail closed. The server also pushes `REAUTHORIZE` and may close the socket ([SPEC-06](SPEC-06-authorization-truth-table.md) §6) |
| **Subscription** | Authorized per topic at subscribe **and re-evaluated on every push** for the classes listed in SPEC-06 §6.2 |

---

## 6. Background job binding

| Rule | Detail |
|---|---|
| **Enqueue** | Freezes `expected_organization_id`, `expected_group_id`, acting `membership_id` (or an explicit system-actor marker), `correlation_id`, and the `authorization_version` observed at enqueue |
| **Execution** | Opens a unit of work with that context and **re-evaluates authorization against current state** — not against the frozen decision ([SPEC-06](SPEC-06-authorization-truth-table.md) §5) |
| **Authorization now fails** | The job terminates in an explicit `cancelled_unauthorized` state, is audited, and notifies the requester. **It does not silently succeed and it does not silently vanish** |
| **No context** | The worker **refuses the job**. There is no default tenant |

---

## 7. Test contract

**Extends QA-TEN-004 and SBX-004. Both are pre-existing IDs; neither has been executed.**

### 7.1 Cross-tab and stale context (CAR-001)

| # | Scenario | Required outcome |
|---|---|---|
| T-01 | Two browser contexts, one session; switch group in B; submit a **mutation** from A | A's declared group is honoured; **no write against B** |
| T-02 | Same, but A's membership was revoked meanwhile | `409 CONTEXT_STALE`; **no write, no event, no audit mutation** |
| T-03 | Same for **publication**, **report request**, **document upload**, **job enqueue**, and **WebSocket command** | Identical behaviour on every surface |
| T-04 | Forged `expected_group_id` naming a group the user does not belong to | `404`; logged as a security event |
| T-05 | Valid context, target object from another group, actor **is** authorized for the action in the declared group | `409 CONTEXT_TARGET_MISMATCH` **before any write** *(amended 2026-08-01, V-07)* |
| T-05b | Same, but the actor holds **no** capability for the action in the declared group *(added 2026-08-01, V-07)* | **`404`** — byte-identical to the response for a non-existent id. No timing or body difference |
| T-06 | Long-lived form submitted after an entitlement is revoked | Fails at the entitlement layer with no partial effect |
| T-06b | Organization-scoped action with `expected_group_id = null`, actor holds an active organization membership and organization role *(added 2026-08-01, V-06)* | Accepted; `membership_id` resolves to the organization membership |
| T-06c | Organization-scoped action, actor holds only a **group** membership in that organization *(added 2026-08-01, V-06)* | `404` — a group membership never satisfies an organization-scoped action ([SPEC-06](SPEC-06-authorization-truth-table.md) §1, disjoint composition) |
| T-06d | Group-scoped action with `expected_group_id = null` *(added 2026-08-01, V-06)* | `404` — the branch is selected by the route's declared scope, never by the presence or absence of the field |

### 7.2 Pooled-connection and failure-path isolation (CAR-002)

**A concurrency harness runs two organizations continuously against every tenant table under `app_runtime` and `app_worker` while injecting faults.**

| # | Injected fault | Required outcome |
|---|---|---|
| T-07 | Exception mid-transaction | Rollback; **next checkout sees no setting** |
| T-08 | Statement cancellation / client timeout | Same |
| T-09 | Statement timeout at the server | Same |
| T-10 | Connection killed mid-transaction | Same; pool discards the connection |
| T-11 | Nested unit of work, same tenant | Permitted (savepoint) |
| T-12 | Nested unit of work, **different** tenant | **Throws.** Never permitted |
| T-13 | Query issued **outside** any unit of work | **Zero rows / write rejected** — fail-closed, not fail-open |
| T-13b | Unit of work for Group A in Org 1; query a group-scoped table for Group B in the **same** organization *(added 2026-08-01, V-09)* | **Zero rows / write rejected** by the group predicate, without relying on the application layer |
| T-14 | Pooler in statement-pooling mode | **Harness fails loudly** — the configuration is prohibited, and the test proves the prohibition is detectable. *(amended 2026-08-01, V-10)* The test asserts **all three** consequences of the read-back mismatch: (a) the transaction is **aborted** with `CONTEXT_READBACK_MISMATCH` and no row is written; (b) the connection is **discarded** from the pool and is never handed to another borrower; (c) an **operational alert** is emitted |
| T-15 | 10 000 interleaved operations across two orgs, randomised faults | **Zero rows from the wrong tenant. Any single occurrence is a hard failure** |

**Earliest execution point: the schema/prototype stage, before feature work** — per CAR-025, this harness is not a late gate.

---

## 8. Traceability

**Capabilities:** CAP-001, CAP-002, CAP-003, CAP-006, CAP-014, CAP-019, CAP-031, CAP-032, and every tenant-scoped capability.
**Decisions:** PO-DEC-02 (approved), PO-DEC-06 (pending — one user across multiple organizations would add `expected_organization_id` variation but not change the mechanism).
**ADRs:** [ADR-0003](../decisions/ADR-0003-database-and-tenancy-strategy.md) (revised), [ADR-0004](../decisions/ADR-0004-authorization-architecture.md), **[ADR-0022](../decisions/ADR-0022-request-scoped-tenant-context.md) (new)**.
**Gates:** `G-ARCH`, `G-PROD`. **None passed. No test above has been executed.**
