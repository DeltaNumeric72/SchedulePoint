# ADR-0004 — Authorization Architecture

**Status:** `PROPOSED` — 2026-07-31. Not accepted. **Implements the product-owner-approved decision PO-DEC-02.**

## Context

Contradiction **C-02** recorded that the source product's permission surfaces could not be reconciled: settings existed whose behavioural effect could not be established, and two similar-sounding controls could not be distinguished. Copying that model would reproduce the confusion.

The product's real structure is four-dimensional: an organization buys modules; a group has some of them available; a person holds a role **per membership**, differing across groups; and each action requires a specific capability.

## Decision

**Four layers, evaluated in order, deny-by-default at every layer:**

```
organization entitlement → group/module availability → membership role → explicit action capability
```

**Every route declares its required capability. A route with no declaration fails the build** — not at runtime, at build time. Object-level checks re-verify tenant and scope after loading. RLS (ADR-0003) is the final layer.

**The rule that prevents C-02 from recurring: no permission flag may exist without a test demonstrating an observable capability difference.** A flag whose presence changes nothing is not a permission; it is a defect.

Impersonation is **its own capability**, never implied by an administrative role, and every action taken under it records both the operator and the impersonated user (`on_behalf_of`).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Flat role list** | Cannot express "entitled but not permitted", which is exactly the distinction the product needs |
| **Copy the source's model** | Would reproduce C-02 — an unreconcilable permission surface |
| **Pure ABAC / policy engine** | More expressive than needed now; harder to reason about and to test exhaustively. **Not foreclosed**: capabilities are evaluated behind a resolver that could delegate later |
| **Permissions only, entitlements folded in** | The failure mode PO-DEC-04 exists to prevent — commercial packaging and access control become permanently entangled |

## Consequences

**Positive:** each layer is independently testable · the entitlement/permission distinction stays clean · role changes cannot silently grant module access · impersonation is auditable by construction.

**Negative:** four layers to reason about on every request · a capability catalogue to maintain · **the "no flag without a tested difference" rule adds real test-writing cost** — deliberately, since that cost is the mechanism.

## Security implications

Primary mitigation for T-02 (authorization bypass), T-05 (privilege escalation), and T-06 (impersonation abuse). **Every authorization denial is logged**, and anomalous denial spikes alert — repeated denials are what probing looks like. Group switching re-resolves the capability set; a stale set is never reused.

## Operational implications

The capability catalogue is a maintained artifact. Adding a route without declaring a capability is a build failure, so the enforcement is felt at development time rather than in production.

## Capability mappings

CAP-006 (the model itself); CAP-002, CAP-005, CAP-007..CAP-010, CAP-034, CAP-042, CAP-044 directly; every capability with a permission surface indirectly.

## Gate mappings

`G-ARCH` — CAP-006. `G-BETA` — CAP-005, CAP-008, CAP-009, CAP-010, CAP-034, CAP-042. `G-PROD` — CAP-003, CAP-044. Tests: SBX-001, SBX-002, SBX-005.

## Unresolved validation

- SBX-001 (role × route matrix) and SBX-002 (capability-difference pairs) have not been executed.
- The complete capability catalogue is not enumerated — it emerges with implementation.
- PO-DEC-06 (one user across multiple organizations) is pending and would change context resolution if decided otherwise.
