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

**Context is an immutable value constructed once per request, job, or socket command, and never mutated thereafter.**

| Field | Source | Purpose |
|---|---|---|
| `principal_user_id` | Session (server-side) | Who is acting |
| `expected_organization_id` | **Client-declared, server-verified** | What the caller *believed* it was acting on |
| `expected_group_id` | **Client-declared, server-verified** | Same, at group scope |
| `membership_id` | Derived server-side from `(principal_user_id, expected_group_id)` | The acting membership |
| `context_version` | Monotonic counter on the **membership set**, bumped on any role, capability, entitlement, availability, proxy, or membership-status change | Freshness |
| `session_epoch` | Bumped on privilege change, impersonation start/end, and re-authentication | Session freshness |
| `authorization_version` | Hash of the resolved policy inputs (see [SPEC-06](SPEC-06-authorization-truth-table.md)) | Cache validity |
| `correlation_id` | Generated at the edge | Traceability |
| `on_behalf_of_membership_id?` | Impersonation or proxy | Attribution |

**`expected_*` is declared by the client and *verified*, not *trusted*.** This is the inversion that fixes CAR-001. The old rule — "never accept a client tenant identifier" — prevented forgery but *caused* silent retargeting. The correct rule is:

> **I-14 — The client declares which tenant it believes it is addressing. The server verifies that declaration against server-side membership and against the target aggregate, and rejects a mismatch. It never substitutes its own current value.**

A forged `expected_group_id` fails membership verification exactly as before. A **stale** one now fails too, instead of being silently replaced.

### 2.2 Where the declaration comes from

| Surface | Carrier |
|---|---|
| HTML form / page | Hidden field rendered at page load, plus the path segment |
| JSON API | Path segment `/organizations/{org}/groups/{group}/…` **and** an `X-SchedulePoint-Context` header carrying `context_version` and `session_epoch` |
| WebSocket | Bound at connect **and** re-declared on **every command frame** (§5) |
| Background job | Frozen into the job payload at enqueue (§6) |

**The path segment is not sufficient on its own** — it identifies the tenant but not the freshness. Both are required.

### 2.3 Validation sequence

Executed in order; the first failure aborts **before any write and before any event**:

| # | Check | Failure response |
|---|---|---|
| 1 | `expected_organization_id` exists and is active | `404` — indistinguishable from not-permitted |
| 2 | A membership exists for `(principal_user_id, expected_group_id)` and is `active` | `404` |
| 3 | `expected_group_id` belongs to `expected_organization_id` | `404` |
| 4 | `context_version` matches the current membership-set version | **`409 CONTEXT_STALE`** with a re-fetch directive |
| 5 | `session_epoch` matches | **`409 SESSION_STALE`** — forces re-authentication of context |
| 6 | **Target aggregate binding** (§3) | **`409 CONTEXT_TARGET_MISMATCH`** |
| 7 | Authorization ([SPEC-06](SPEC-06-authorization-truth-table.md)) | `403` or `404` per policy |

**Steps 4–6 are the CAR-001 remediation.** Steps 1–3 existed before and were never the problem.

### 2.4 Distinguishing stale from forbidden

A stale context is a **recoverable user-interface condition**, not an attack. It returns a distinct status so the client can say "this tab is showing Group A but you have switched to Group B — reload or switch back," rather than failing mysteriously or, worse, succeeding against the wrong group.

**Forgery and cross-tenant probing still return `404`** with no distinction between "does not exist" and "not permitted."

---

## 3. Target aggregate binding

**Every command that names an object must prove the object lives in the declared tenant — before the command runs, not as a side effect of a query filter.**

```
resolve(target_id) → { organization_id, group_id, aggregate_type, aggregate_version }
assert target.organization_id == ctx.expected_organization_id
assert target.group_id        == ctx.expected_group_id
assert target.aggregate_type  == the type this route operates on
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
    verify: SELECT current_setting('app.organization_id', true) == expected   -- read-back
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
| **Read-back verification** | Catches a misconfigured pooler that silently discards `SET LOCAL` |
| **No nested transaction may change tenant** | A nested `withUnitOfWork` with a *different* tenant is a programming error and **throws**. Savepoints are permitted; re-tenanting is not |
| **`SET` (session form) is prohibited** | A lint rule and a CI grep forbid non-`LOCAL` tenant settings anywhere in the codebase |
| **Pool mode constraint** | The connection pooler **must** operate in session or transaction mode with transaction affinity. **Statement-level pooling is incompatible with this design and is prohibited** ([SPEC-15](SPEC-15-technology-decision-gates.md) TDG-03) |

### 4.3 Denying access outside the wrapper

Belt and braces, because a wrapper you can forget is a wrapper that will be forgotten:

| Mechanism | Effect |
|---|---|
| **RLS policies read `current_setting('app.organization_id', true)`** | Outside a unit of work the setting is `NULL`, the predicate is false, and **every tenant table returns zero rows and rejects every write** |
| **`FORCE ROW LEVEL SECURITY`** on every tenant table | The owner bypass does not apply to the application role even if ownership is misconfigured |
| **Non-owner application role** | `app_runtime` owns nothing, is not superuser, and does not hold `BYPASSRLS` |
| **Non-owner worker role** | `app_worker` — same constraints, separate credentials, separate grants |
| **Migration role** | `app_migrator` owns the schema, runs only migrations, and is **never** used by a running process |
| **Repository lint** | Raw client access outside the repository layer fails the build |

**Fail-closed is the important half.** Forgetting the wrapper does not produce a leak; it produces zero rows — a loud, immediate, obviously-broken failure in development.

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
| T-05 | Valid context, target object from another group | `409 CONTEXT_TARGET_MISMATCH` **before any write** |
| T-06 | Long-lived form submitted after an entitlement is revoked | Fails at the entitlement layer with no partial effect |

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
| T-14 | Pooler in statement-pooling mode | **Harness fails loudly** — the configuration is prohibited, and the test proves the prohibition is detectable |
| T-15 | 10 000 interleaved operations across two orgs, randomised faults | **Zero rows from the wrong tenant. Any single occurrence is a hard failure** |

**Earliest execution point: the schema/prototype stage, before feature work** — per CAR-025, this harness is not a late gate.

---

## 8. Traceability

**Capabilities:** CAP-001, CAP-002, CAP-003, CAP-006, CAP-014, CAP-019, CAP-031, CAP-032, and every tenant-scoped capability.
**Decisions:** PO-DEC-02 (approved), PO-DEC-06 (pending — one user across multiple organizations would add `expected_organization_id` variation but not change the mechanism).
**ADRs:** [ADR-0003](../decisions/ADR-0003-database-and-tenancy-strategy.md) (revised), [ADR-0004](../decisions/ADR-0004-authorization-architecture.md), **[ADR-0022](../decisions/ADR-0022-request-scoped-tenant-context.md) (new)**.
**Gates:** `G-ARCH`, `G-PROD`. **None passed. No test above has been executed.**
