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

> **AMENDED 2026-08-01 (V-24)** — organization-level roles were named in CAR-008 and claimed answered, but had no evaluation path: `PolicyInput` carried exactly one membership and one role, and L3.1 unconditionally required a group membership, so **every** organization-scoped action — entitlement administration, group creation, user administration, platform administration (M-25) — evaluated to `DENY NO_MEMBERSHIP`. Implementation would have had to invent an ungoverned branch or exempt those routes from the evaluator, and §7 says a surface with its own authorization logic is a defect. `PolicyInput`, L0.2, and L3 now branch on the action's declared scope ([rationale](../remediation/internal-verification-corrections.md) §2). This is the authorization half of the same gap [SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §2.1 closes on the context side (V-06).

```
PolicyInput {
  organization  { id, status }
  entitlement   { module_key, state, effective_from, effective_to }        -- for the action's module
  module_deps   [ { module_key, depends_on, satisfied } ]
  group?        { id, status }              -- null for organization-scoped actions   [V-24]
  availability  { module_key, available }
  membership?   { id, status, role_id, valid_from, valid_to }   -- GROUP membership; null when org-scoped
  role?         { id, is_system_role }                          -- the group role
  role_caps     [ capability_key ]                              -- the group role's capabilities
  org_membership? { id, status, org_role_id, valid_from, valid_to }   -- NEW 2026-08-01, V-24
  org_role?       { id, is_system_role }                             -- NEW 2026-08-01, V-24
  org_role_caps   [ capability_key ]                                 -- NEW 2026-08-01, V-24
  grants        [ { capability_key, granted: bool, valid_from, valid_to } ]
  proxy?        { grantor_membership_id, scope, status, valid_from, valid_to }
  impersonation?{ operator_user_id, expires_at }
  target?       { organization_id, group_id, type, owner_membership_id?, state }
  action        { key, module_key, scope: 'group' | 'organization',   -- NEW 2026-08-01, V-24
                  requires_object_policy: bool }
  now
}
```

### 1.1 Action scope, and the organization-scoped action set *(added 2026-08-01, V-24)*

**Every action declares `scope` in its policy declaration.** P-4's deny-by-default and A-14's build-time check apply to the scope declaration exactly as they apply to the capability: an action with no declared scope fails the build. **This enumeration is the one [SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §2.1 refers to.**

| Organization-scoped action class | Examples | Governing module |
|---|---|---|
| **Entitlement administration** | Grant, suspend, revoke, and re-window a module entitlement | Entitlements ([05](../05-tenancy-entitlements-authorization.md) §3) |
| **Group administration** | Create, rename, deactivate a group; set group module availability | Organization administration |
| **User and membership administration** | Invite a user to the organization, end a membership, assign a group role | Organization administration |
| **Role and capability administration** | Manage `role_capabilities`, define organization roles | Organization administration |
| **Organization profile and settings** | Organization status, billing contact, organization-wide policy | Organization administration |
| **Platform administration** | Cross-organization operations | M-25 · [04](../04-domain-boundaries.md) |

**Everything not in this enumeration is group-scoped.** The default is the narrower scope, deliberately.

### 1.2 How organization capabilities compose with group capabilities *(added 2026-08-01, V-24)*

**The two capability sets are disjoint. This is the conservative composition, and it is chosen deliberately.**

| Rule | Statement |
|---|---|
| **P-8** *(new, 2026-08-01, V-24)* | **An organization role never satisfies a group-scoped action.** Holding `org_admin` does not grant `schedule.publish` in any group. Cross-scope access requires a **group membership** in that group, with a group role, evaluated by the ordinary L3/L4 path |
| **P-9** *(new, 2026-08-01, V-24)* | **A group role never satisfies an organization-scoped action.** A group administrator cannot administer entitlements |
| **P-10** *(new, 2026-08-01, V-24)* | The two capability namespaces do not overlap: a capability key is declared as organization-scoped or group-scoped, never both. A key declared in both fails the build (A-16) |

**Why disjoint rather than hierarchical.** A hierarchical composition — "an organization administrator implicitly holds every group capability" — is the convenient answer and the wrong one here: it would hand the highest-privilege role in the product silent, unaudited authority over clinical allocation in every group, and it would make the blast radius of a mis-assigned organization role the whole organization's schedule. If an organization administrator genuinely needs to act inside a group, they take a group membership, which is visible, enumerable, revocable, and audited. **The inconvenience is the control.**

---

## 2. The normative truth table

**Evaluated strictly in order. The first `DENY` terminates evaluation. There is no later layer that can rescue an earlier denial.**

> **AMENDED 2026-08-01 (V-24)** — L0.2, L2.1, L3.1–L3.3 and L4.2 branch on `action.scope`. The group branch is **unchanged in every respect**; the organization branch is new.

| Step | Condition | Result if false |
|---:|---|---|
| **L0.1** | `organization.status = active` | **DENY** `ORG_INACTIVE` |
| **L0.2** | **`scope = group`:** `group.status = active`. **`scope = organization`:** skipped — there is no group to check *(amended 2026-08-01, V-24)* | **DENY** `GROUP_INACTIVE` |
| **L1.1** | An entitlement row exists for the action's module | **DENY** `NOT_ENTITLED` |
| **L1.2** | `entitlement.state ∈ {trial, active}` | **DENY** `ENTITLEMENT_SUSPENDED` / `_REVOKED` |
| **L1.3** | `now ∈ [effective_from, effective_to)` | **DENY** `ENTITLEMENT_EXPIRED` |
| **L1.4** | **Every declared dependency of the module is itself satisfied by L1.1–L1.3** | **DENY** `MODULE_DEPENDENCY_UNSATISFIED` |
| **L2.1** | **`scope = group`:** `group_module_availability.available = true` for the module. **`scope = organization`:** skipped — availability is a group-level setting *(amended 2026-08-01, V-24)* | **DENY** `MODULE_UNAVAILABLE_IN_GROUP` |
| **L3.1** | **`scope = group`:** a **group membership** exists for `(principal, group)`. **`scope = organization`:** an **organization membership** exists for `(principal, organization)` **and carries an organization role** *(amended 2026-08-01, V-24)* | **DENY** `NO_MEMBERSHIP` / `NO_ORG_MEMBERSHIP` |
| **L3.2** | The membership selected at L3.1 has `status = active` *(amended 2026-08-01, V-24)* | **DENY** `MEMBERSHIP_SUSPENDED` / `_ENDED` / `_INVITED` |
| **L3.3** | `now ∈ [valid_from, valid_to)` for the membership selected at L3.1 *(amended 2026-08-01, V-24)* | **DENY** `MEMBERSHIP_EXPIRED` |
| **L4.1** | **An in-window `grants` row exists with `granted = false`** | **DENY** `EXPLICIT_DENY` — *explicit deny beats every allow* |
| **L4.2** | An in-window `grants` row exists with `granted = true`, **or** `action.key ∈ role_caps` (`scope = group`) / `action.key ∈ org_role_caps` (`scope = organization`). **The two sets are disjoint — P-8/P-9/P-10** *(amended 2026-08-01, V-24)* | **DENY** `NO_CAPABILITY` |
| **L5.1** | Object policy passes (§3) — for actions requiring one. **This is where tenant binding is evaluated: at L5.1, after L4** *(clarified 2026-08-01, V-07/V-25)* | **DENY** `OBJECT_POLICY` |
| **L6.1** | Proxy constraints satisfied (§3.2), if acting as proxy *(reference renumbered 2026-08-01, V-26)* | **DENY** `PROXY_*` |
| **L6.2** | Impersonation constraints satisfied (§3.3), if impersonating *(reference renumbered 2026-08-01, V-26)* | **DENY** `IMPERSONATION_*` |
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

> **AMENDED 2026-08-01 (V-07 / V-25, V-26)** — two corrections ([rationale](../remediation/internal-verification-corrections.md) §2):
> 1. **The tenant-binding row said "evaluated before L4" while §2's own table places object policy at L5.1, after L4.** The table was right and the sentence was wrong. Evaluating tenant binding before the capability check is what let an unauthorized holder of a UUID distinguish "exists elsewhere" (`409`) from "does not exist" (`404`) before any capability check ran — and P-5/P-6's disclosure discipline is built on the L4-then-L5 ordering. The sentence is corrected below.
> 2. **§3's subsections skipped §3.1 and §3.2**, so a reader could not tell whether content was missing. They are renumbered consecutively; no content is added or removed by the renumbering.

### 3.1 Policy set *(renumbered 2026-08-01, V-26; previously the untitled table under §3)*

| Policy | Rule |
|---|---|
| **Tenant binding** | `target.organization_id = ctx.expected_organization_id` **and**, for group-scoped actions, `target.group_id = ctx.expected_group_id`. **Evaluated at L5.1 — *after* L4, not before it** *(amended 2026-08-01, V-07/V-25)*. Failure yields `409 CONTEXT_TARGET_MISMATCH` **only when the actor passed L4 in their declared tenant**; otherwise `404`, disclosing nothing ([SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §2.3 step 6 and §2.4) |
| **Ownership** | Self-scoped actions (own profile, own request, own assignment) require `target.owner_membership_id = ctx.membership_id` **unless** a distinct administrative capability is held |
| **State** | Some actions are legal only in some target states (publish requires `approved`; claim requires `posted`). **Checked inside the mutating transaction, not before it** |
| **Cross-group** | Denied unless an explicit cross-group capability is held. Not implied by any role — and, per **P-8**, not implied by an organization role either *(amended 2026-08-01, V-24)*. The declared database-level exceptions are enumerated in [SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §4.3 |

### 3.2 Proxy *(renumbered from §3.3, 2026-08-01, V-26)*

| Constraint | Rule |
|---|---|
| Grant is `active`, in window, and from the correct grantor | Else `PROXY_INVALID` |
| `scope = 'act-on-behalf'` for acting operations | `notifications-only` cannot act — `PROXY_SCOPE` |
| **The grantor must independently pass L0–L5 for the same action** | A proxy can never exceed the grantor — `PROXY_GRANTOR_DENIED` |
| **The proxy must pass L0–L3 in their own right** | A suspended proxy cannot act — `PROXY_MEMBERSHIP` |
| Attribution | **Both parties recorded**, always |

### 3.3 Impersonation *(renumbered from §3.4, 2026-08-01, V-26)*

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
| **Per-push evaluation for sensitive topics** | Picklist state, schedule changes, and directory updates re-check subscription authority before each push. Low-sensitivity topics re-check on a bounded interval. **Batching and failure behaviour are specified in §6.1** *(amended 2026-08-01, V-26)* |
| **Privilege change** | Bumps `membership_set_version` → in-flight and subsequent frames fail `CONTEXT_STALE` → server pushes `REAUTHORIZE` |
| **Revocation, suspension, entitlement loss** | **Affected subscriptions are closed immediately** and the socket is closed if no authorized subscription remains |
| **Fan-out on change** | The authorization module publishes a `PrincipalAuthorizationChanged` event; the coordinator maps it to affected connections |

**The review's scenario — *"a scheduler's picklist capability is revoked while a page remains connected; the same socket keeps submitting authorized commands"* — fails at L4.2 on the very next frame, and the subscription is closed without waiting for one.**

### 6.1 Per-push evaluation: cost bound and failure behaviour *(added 2026-08-01, V-26)*

> **AMENDED 2026-08-01 (V-26)** — the per-push rule is correct in principle and is the right answer to CAR-008, but with no bound it collided with the turn-latency requirements in [10](../10-picklist-and-realtime.md), and the behaviour when the evaluator is slow or unavailable **during a live clinical allocation** was undefined. A picklist broadcast fans out to every participant on every turn transition ([rationale](../remediation/internal-verification-corrections.md) §2).

| Rule | Detail |
|---|---|
| **Batching is permitted, per fan-out** | **One evaluation per recipient per event.** A single turn transition produces one subscription-authority decision per subscribed recipient, and that decision may be reused for **every frame belonging to that event's fan-out** — no longer. This is a bound, not a cache: the decision's lifetime is the fan-out, and it is discarded when the fan-out completes |
| **Why batching is legitimate here** | These are **subscription-authority** checks, not object policies. §4's no-caching rule covers object policies and irreversible actions — a picklist *selection* is still evaluated fresh, per command frame, every time. Deciding once per recipient per event that they may *see* the event does not weaken that |
| **A version bump invalidates immediately** | If `membership_set_version`, `organization_version`, or `group_version` changes mid-fan-out, in-flight batched decisions for the affected principal are discarded and re-evaluated. Revocation is never delayed by batching |
| **Evaluator failure during a live turn: fail closed, per recipient** | If the authorization evaluation for a recipient **fails or times out**, that recipient's push **stops**. It is not sent on a stale decision, and it is not sent unevaluated. Failure is scoped to the affected recipient — one slow evaluation does not stop the fan-out for everyone else |
| **The user is told, and can recover** | A recipient whose pushes have stopped sees the **client staleness indicator** and is offered the **resync path** ([10](../10-picklist-and-realtime.md), [SPEC-02](SPEC-02-picklist-turn-transaction.md) §8 reconnect-and-replay). PO-DEC-18's requirement that staleness be *visible* rather than silent already exists and is what makes fail-closed acceptable here: the participant is not left believing they are watching a live list when they are not |
| **The turn itself is unaffected** | Broadcast is a relay of `picklist_events`, never a source of truth ([SPEC-02](SPEC-02-picklist-turn-transaction.md) §8). A recipient who missed pushes converges on reconnect via sequence replay or snapshot. **No allocation outcome depends on a push arriving** |
| **Observability** | Per-push evaluation latency and fail-closed counts are first-class metrics; a rising fail-closed rate during turns is an operational alert, not a silent degradation |

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

Dimensions: **action scope (2: group / organization)** *(added 2026-08-01, V-24)* × org status (2) × entitlement state (5) × effective window (3) × dependency satisfied (2) × availability (2) × membership status (4) × role (6) × **organization membership status (4)** and **organization role (3)** *(added 2026-08-01, V-24)* × explicit grant (3: allow / deny / absent) × object ownership (3) × proxy state (4) × impersonation (2).

**The scope dimension is not a free multiplier.** Group-scoped rows hold `org_membership = absent`; organization-scoped rows hold `membership = absent` and skip L0.2/L2.1. Both halves are generated and asserted; the generator fails if either half is empty for any capability.

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
| A-14 | Route with no declared policy — **or no declared `scope`** *(amended 2026-08-01, V-24)* | **Build fails** |
| A-15 | Every capability's allow/deny pair | **A capability without a pair fails CI** (A-3) |
| A-16 | A capability key declared in **both** the group and organization namespaces *(added 2026-08-01, V-24)* | **Build fails** (P-10) |
| A-17 | Organization-scoped action; actor holds an active organization membership with an organization role carrying the capability *(added 2026-08-01, V-24)* | **ALLOW.** L0.2 and L2.1 skipped; L3.1 satisfied by the organization membership |
| A-18 | Organization-scoped action; actor holds **only** a group membership, with a group role that carries a same-named group capability *(added 2026-08-01, V-24)* | **DENY** `NO_ORG_MEMBERSHIP` (P-9) |
| A-19 | Group-scoped action; actor holds **only** an organization role, including `org_admin` *(added 2026-08-01, V-24)* | **DENY** `NO_MEMBERSHIP` (P-8). An organization role never reaches into a group |
| A-20 | Organization-scoped action; organization membership suspended, expired, or lacking an organization role *(added 2026-08-01, V-24)* | **DENY** at L3.1/L3.2/L3.3 respectively |
| A-21 | Picklist turn transition fanning out to N subscribers *(added 2026-08-01, V-26)* | **Exactly one subscription-authority evaluation per recipient per event**, reused across that event's frames and discarded at fan-out end |
| A-22 | Authorization evaluator times out for **one** recipient mid-fan-out *(added 2026-08-01, V-26)* | That recipient's push **stops** (fail closed) and their client shows the staleness indicator; **every other recipient is unaffected**; no push is sent on a stale or unevaluated decision |
| A-23 | Capability revoked **during** a fan-out *(added 2026-08-01, V-26)* | The batched decision for that principal is discarded immediately; no further push reaches them; the subscription closes per §6 |

---

## 9. Traceability

**Capabilities:** CAP-006, CAP-008, CAP-010, CAP-032, CAP-034, CAP-042, CAP-044, CAP-057, and every protected capability.
**Decisions:** PO-DEC-02 (approved), PO-DEC-04 (approved, technical only), PO-DEC-11 and PO-DEC-19 (pending).
**ADRs:** [ADR-0004](../decisions/ADR-0004-authorization-architecture.md), [ADR-0005](../decisions/ADR-0005-entitlement-architecture.md), [ADR-0008](../decisions/ADR-0008-realtime-picklist-transport.md).
**Gates:** `G-ARCH`, `G-BETA`, `G-PROD`. **None passed.**
