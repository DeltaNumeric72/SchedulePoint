# SPEC-06 — Authorization Truth Table, Freshness, and Revocation

**Status: `PROPOSED`.** Remediates **CAR-008** (High).
**Supersedes:** [05](../05-tenancy-entitlements-authorization.md) §§1, 3, 4.2, 4.4–4.6, 7.
**New invariant:** **I-19**. **ADRs:** [ADR-0004](../decisions/ADR-0004-authorization-architecture.md) (revised), [ADR-0005](../decisions/ADR-0005-entitlement-architecture.md) (revised).

> **What was wrong.** The four layers were *named* but never *defined*. `role_capabilities` granted; `capability_grants.granted` could apparently grant **or deny**; nothing said which wins. Disabled modules, organization-level roles, module-dependency failure, suspended memberships, and expired entitlements had no defined behaviour. Background jobs captured context but were not required to re-authorize at execution. WebSockets authorized at connect and subscribe, so a revoked capability stayed effective for the life of the socket. No cache invalidation existed because no cache versioning existed.

---

## 1. One pure evaluator

**I-19 — Every protected operation — HTTP request, job execution, WebSocket command, report execution, artifact download, export, and support action — is decided by the same pure authorization function evaluated against current state at the moment of the operation.**

```
authorize(ctx, action, target?) -> Allow | Deny(reason)
```

**Pure:** its output depends only on its inputs. It performs no I/O; the caller assembles a `PolicyInput` snapshot and passes it in. That is what makes exhaustive table-driven testing possible.

```
PolicyInput {
  organization  { id, status }
  entitlement   { module_key, state, effective_from, effective_to }        -- for the action's module
  module_deps   [ { module_key, depends_on, satisfied } ]
  group         { id, status }
  availability  { module_key, available }
  membership    { id, status, role_id, valid_from, valid_to }
  role          { id, is_system_role }
  role_caps     [ capability_key ]
  grants        [ { capability_key, granted: bool, valid_from, valid_to } ]
  proxy?        { grantor_membership_id, scope, status, valid_from, valid_to }
  impersonation?{ operator_user_id, expires_at }
  target?       { organization_id, group_id, type, owner_membership_id?, state }
  action        { key, module_key, requires_object_policy: bool }
  now
}
```

---

## 2. The normative truth table

**Evaluated strictly in order. The first `DENY` terminates evaluation. There is no later layer that can rescue an earlier denial.**

| Step | Condition | Result if false |
|---:|---|---|
| **L0.1** | `organization.status = active` | **DENY** `ORG_INACTIVE` |
| **L0.2** | `group.status = active` (group-scoped actions) | **DENY** `GROUP_INACTIVE` |
| **L1.1** | An entitlement row exists for the action's module | **DENY** `NOT_ENTITLED` |
| **L1.2** | `entitlement.state ∈ {trial, active}` | **DENY** `ENTITLEMENT_SUSPENDED` / `_REVOKED` |
| **L1.3** | `now ∈ [effective_from, effective_to)` | **DENY** `ENTITLEMENT_EXPIRED` |
| **L1.4** | **Every declared dependency of the module is itself satisfied by L1.1–L1.3** | **DENY** `MODULE_DEPENDENCY_UNSATISFIED` |
| **L2.1** | `group_module_availability.available = true` for the module | **DENY** `MODULE_UNAVAILABLE_IN_GROUP` |
| **L3.1** | A membership exists for `(principal, group)` | **DENY** `NO_MEMBERSHIP` |
| **L3.2** | `membership.status = active` | **DENY** `MEMBERSHIP_SUSPENDED` / `_ENDED` / `_INVITED` |
| **L3.3** | `now ∈ [membership.valid_from, membership.valid_to)` | **DENY** `MEMBERSHIP_EXPIRED` |
| **L4.1** | **An in-window `grants` row exists with `granted = false`** | **DENY** `EXPLICIT_DENY` — *explicit deny beats every allow* |
| **L4.2** | An in-window `grants` row exists with `granted = true`, **or** `action.key ∈ role_caps` | **DENY** `NO_CAPABILITY` |
| **L5.1** | Object policy passes (§3) — for actions requiring one | **DENY** `OBJECT_POLICY` |
| **L6.1** | Proxy constraints satisfied (§3.3), if acting as proxy | **DENY** `PROXY_*` |
| **L6.2** | Impersonation constraints satisfied (§3.4), if impersonating | **DENY** `IMPERSONATION_*` |
| | **All passed** | **ALLOW** |

### 2.1 Precedence, stated unambiguously

| Rule | Statement |
|---|---|
| **P-1** | **Explicit deny (L4.1) beats role allow and beats explicit allow.** A `granted = false` row is absolute within its validity window |
| **P-2** | **Explicit allow (L4.2) supplements a role; it never substitutes for L0–L3.** A grant cannot resurrect an unentitled module or a suspended membership |
| **P-3** | **Entitlement is evaluated before permission.** A user must not learn a module's shape from a permission error |
| **P-4** | **Deny-by-default.** An action with no declared policy denies and **fails its build-time check** |
| **P-5** | **A denial at L0–L2 is reported as `404`.** Existence of an unentitled module is not disclosed |
| **P-6** | **A denial at L3–L6 is reported as `403`** where the actor may know the object exists, and **`404`** where knowing that is itself disclosure |
| **P-7** | Overlapping grant windows for one capability are **prohibited by an exclusion constraint** — P-1 needs a single unambiguous row |

### 2.2 Disabled modules and data retention

**PO-DEC-04 requires that disabling never deletes data. That produces obligations the previous design left undefined:**

| Question | Answer |
|---|---|
| Data when a module is disabled? | **Retained, unmodified, indefinitely** |
| Read access? | **Denied at L1/L2** like everything else. Retained ≠ reachable |
| Re-enable? | Full access restored, data intact. No migration, no reconstruction |
| Background jobs for a disabled module? | **Terminate `cancelled_unentitled`** at re-authorization (§5) |
| In-flight real-time subscriptions? | **Closed** on the entitlement change (§6) |
| Reports already generated? | **Download denied** while disabled; the artifact is retained, not purged |
| Does disabling stop *inbound* effects? | Yes — a connector on a disabled module stops importing and records why |
| Support/export of retained data? | Through a **platform-administration path with its own capability**, audited, and never through the disabled module's own surfaces |

---

## 3. Object policies

| Policy | Rule |
|---|---|
| **Tenant binding** | `target.organization_id = ctx.expected_organization_id` **and** `target.group_id = ctx.expected_group_id`. Failure is `409 CONTEXT_TARGET_MISMATCH` ([SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §3), evaluated **before** L4 |
| **Ownership** | Self-scoped actions (own profile, own request, own assignment) require `target.owner_membership_id = ctx.membership_id` **unless** a distinct administrative capability is held |
| **State** | Some actions are legal only in some target states (publish requires `approved`; claim requires `posted`). **Checked inside the mutating transaction, not before it** |
| **Cross-group** | Denied unless an explicit cross-group capability is held. Not implied by any role |

### 3.3 Proxy

| Constraint | Rule |
|---|---|
| Grant is `active`, in window, and from the correct grantor | Else `PROXY_INVALID` |
| `scope = 'act-on-behalf'` for acting operations | `notifications-only` cannot act — `PROXY_SCOPE` |
| **The grantor must independently pass L0–L5 for the same action** | A proxy can never exceed the grantor — `PROXY_GRANTOR_DENIED` |
| **The proxy must pass L0–L3 in their own right** | A suspended proxy cannot act — `PROXY_MEMBERSHIP` |
| Attribution | **Both parties recorded**, always |

### 3.4 Impersonation

Distinct capability; time-limited; banner-visible; **credential, MFA, and token surfaces unreachable**; every action records `on_behalf_of`. **An impersonating operator's effective capability set is the intersection of their own and the impersonated user's** — impersonation is for reproducing what a user sees, not for acquiring their access.

---

## 4. Freshness and cache versioning

**Every cached decision carries the version of the inputs that produced it. A stale version is not used.**

| Version counter | Bumped by |
|---|---|
| `organization_version` | Org status, entitlement, or module-dependency change |
| `group_version` | Group status or module-availability change |
| `membership_set_version` (per user) | Membership add/remove/status, role change, grant change, proxy change |
| `session_epoch` | Authentication, privilege change, impersonation start/end |

`authorization_version = hash(organization_version, group_version, membership_set_version, session_epoch)`.

| Rule | Detail |
|---|---|
| **Bounded TTL** | No cached decision outlives **30 seconds** regardless of version state — a belt-and-braces bound against a missed bump |
| **Version check on every use** | A cached entry whose `authorization_version` differs from current is discarded, not refreshed-in-place |
| **Bump is transactional** | The counter increments **in the same transaction** as the change that caused it. A committed privilege change with an unbumped counter is impossible |
| **Never cached** | Object policies (§3) and any action classified irreversible — publication, picklist selection, approvals, grants, deletion, export |

---

## 5. Background jobs

| Stage | Rule |
|---|---|
| **Enqueue** | Records context and the `authorization_version` then observed |
| **Execution** | **Re-evaluates the full truth table against current state.** The enqueue-time decision is **evidence of intent, never authority** |
| **Now denied** | Terminal state `cancelled_unauthorized`, audited with the denial reason, requester notified. **Not silently dropped, not silently completed** |
| **Long jobs** | Re-evaluate at each durable checkpoint, not only at start |
| **System actors** | An explicit system-actor marker with its own narrow capability set, audited as a system action |

**This directly closes the review's scenario:** *"a queued export runs after the user's access is removed and writes a downloadable report."* It now terminates as `cancelled_unauthorized` and produces no artifact.

---

## 6. Real-time revocation

| Rule | Detail |
|---|---|
| **Per-command evaluation** | Every command frame runs the full truth table. **Connect-time authorization authorizes the connection, not the commands** |
| **Per-push evaluation for sensitive topics** | Picklist state, schedule changes, and directory updates re-check subscription authority before each push. Low-sensitivity topics re-check on a bounded interval |
| **Privilege change** | Bumps `membership_set_version` → in-flight and subsequent frames fail `CONTEXT_STALE` → server pushes `REAUTHORIZE` |
| **Revocation, suspension, entitlement loss** | **Affected subscriptions are closed immediately** and the socket is closed if no authorized subscription remains |
| **Fan-out on change** | The authorization module publishes a `PrincipalAuthorizationChanged` event; the coordinator maps it to affected connections |

**The review's scenario — *"a scheduler's picklist capability is revoked while a page remains connected; the same socket keeps submitting authorized commands"* — fails at L4.2 on the very next frame, and the subscription is closed without waiting for one.**

---

## 7. Surface coverage

**One evaluator, every path. A surface with its own authorization logic is a defect.**

| Surface | Evaluation point |
|---|---|
| HTTP | Route middleware + object policy inside the transaction |
| WebSocket | **Every command frame**; sensitive pushes |
| Background job | **Every execution and checkpoint** |
| Report execution | At execution ([SPEC-09](SPEC-09-report-snapshot-and-artifact-authorization.md) §3) |
| Artifact download | **At download, against current state** |
| Calendar feed | Token → membership → truth table **on every fetch** |
| Object storage | Signed URL issued only after evaluation; short expiry |
| Export | As reports |
| Support tooling | Own capabilities; every read audited |
| Connector ingress | Connection-scoped; **payload cannot influence authorization** |

---

## 8. Test contract

**Extends SBX-001, SBX-002, SBX-005.**

### 8.1 Generated cross-product

Dimensions: org status (2) × entitlement state (5) × effective window (3) × dependency satisfied (2) × availability (2) × membership status (4) × role (6) × explicit grant (3: allow / deny / absent) × object ownership (3) × proxy state (4) × impersonation (2).

**Every combination is evaluated against the §2 table and asserted; the same combination is then executed against HTTP, worker, WebSocket, report download, object storage, and calendar paths, and all six must agree.** A disagreement between surfaces is a hard failure — it means more than one evaluator exists.

### 8.2 Named cases

| # | Case | Required outcome |
|---|---|---|
| A-01 | Explicit deny + role allow | **DENY** (P-1) |
| A-02 | Explicit allow + unentitled module | **DENY** `NOT_ENTITLED` (P-2, P-3) |
| A-03 | Dependency unsatisfied, module entitled | **DENY** `MODULE_DEPENDENCY_UNSATISFIED` |
| A-04 | Suspended membership + valid grant | **DENY** `MEMBERSHIP_SUSPENDED` |
| A-05 | Entitlement expires mid-session | Next request denied |
| A-06 | Capability revoked during live socket | **Next frame denied; subscription closed** |
| A-07 | Capability revoked after enqueue, before execution | `cancelled_unauthorized`; **no artifact** |
| A-08 | Access revoked between generation and download | **Download denied** |
| A-09 | Module disabled, then re-enabled | Denied while disabled; **data intact** on re-enable |
| A-10 | Proxy acts; grantor lacks the capability | **DENY** `PROXY_GRANTOR_DENIED` |
| A-11 | Impersonation reaching a credential surface | **DENY** |
| A-12 | Two overlapping grant windows | **Rejected by the exclusion constraint** |
| A-13 | Cached decision after a version bump | Discarded; re-evaluated |
| A-14 | Route with no declared policy | **Build fails** |
| A-15 | Every capability's allow/deny pair | **A capability without a pair fails CI** (A-3) |

---

## 9. Traceability

**Capabilities:** CAP-006, CAP-008, CAP-010, CAP-032, CAP-034, CAP-042, CAP-044, CAP-057, and every protected capability.
**Decisions:** PO-DEC-02 (approved), PO-DEC-04 (approved, technical only), PO-DEC-11 and PO-DEC-19 (pending).
**ADRs:** [ADR-0004](../decisions/ADR-0004-authorization-architecture.md), [ADR-0005](../decisions/ADR-0005-entitlement-architecture.md), [ADR-0008](../decisions/ADR-0008-realtime-picklist-transport.md).
**Gates:** `G-ARCH`, `G-BETA`, `G-PROD`. **None passed.**
