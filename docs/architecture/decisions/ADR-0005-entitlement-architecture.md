# ADR-0005 — Entitlement Architecture

**Status:** `PROPOSED` — 2026-07-31. Not accepted. **Implements the product-owner-approved decision PO-DEC-04 (technical architecture only; commercial packaging remains pending).**

> **REVISED 2026-08-01 (CAR-008, CAR-016).** Entitlement evaluation is now normative — ordering, dependency failure, effective windows, and **disabled-module data behaviour** are specified in [SPEC-06](../specs/SPEC-06-authorization-truth-table.md) §§2 and 2.2 rather than left to interpretation. **PO-DEC-10 (locum billing) is restored to the canonical register as `pending`;** this ADR no longer assumes its recommendation, and no billing capability exists in scope.

## Context

Contradiction **C-12** recorded that the source's commercial material describes editions and included features, while its application shows no corresponding structure — module availability appears to be arranged out of band. SchedulePoint sells modules; something must decide whether an organization has one.

The tempting shortcut is to express entitlement as a permission. That shortcut is what produced C-02-style confusion in the first place: once commercial packaging and access control share a mechanism, no one can tell whether a user cannot do something because their organization did not buy it or because their role does not allow it.

## Decision

**Entitlements are first-class organization-level records, structurally separate from permissions**, checked **before** any permission evaluation ([05](../05-tenancy-entitlements-authorization.md) §3).

- Entitlements grant **modules**, not individual actions.
- **Modules declare dependencies** (for example, `hospital_integration` depends on `picklist`), and dependency validity is enforced when an entitlement changes — an entitlement set that violates a dependency is rejected.
- **Disabling an entitlement never deletes data.** The module becomes unavailable; its records remain, and re-enabling restores access.
- Entitlement changes are audited.
- **Feature flags are for rollout only and are never a substitute for entitlements.** A flag is not an access control.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Entitlement as a permission flag** | Entangles commercial packaging with access control permanently; reproduces C-02's ambiguity |
| **Out-of-band provisioning** (the source's apparent approach) | Unauditable, error-prone, and invisible to the application — the product cannot explain to a user why something is unavailable |
| **Per-feature entitlement granularity** | A combinatorial catalogue to maintain and sell. Module granularity matches how the product is actually packaged |
| **Disabling deletes data** | Catastrophic and irreversible for a customer who lapses and renews |

## Consequences

**Positive:** "not purchased" and "not permitted" are distinguishable, to engineers and to users · packaging changes do not touch authorization code · dependency validation prevents incoherent configurations · lapse-and-renew is safe.

**Negative:** an additional check on every gated path · the module boundary set must be defined and is a commercial decision, not a technical one · entitlement and permission can drift if the ordering is not enforced.

## Security implications

Entitlement is a **commercial** gate, not a security boundary — but its ordering matters: checking permission first could allow a user to learn the shape of a module their organization has not bought. Entitlement changes are privileged and audited.

## Operational implications

Platform administration (M-25) manages entitlements. Support needs a clear view of an organization's entitlement set to answer "why can't I see this?" without guesswork.

## Capability mappings

CAP-057 directly; CAP-055, CAP-060..CAP-065 (integration modules) and every gated capability indirectly.

## Gate mappings

`G-ARCH` — CAP-057. **Retrofitting entitlements after launch would touch every gated path**, which is why this is an architecture blocker.

## Unresolved validation

- **The module boundary set is not defined** — it is a commercial decision.
- PO-DEC-04 is approved for technical architecture only; **commercial packaging remains pending**.
- No test has verified that disabling preserves data and re-enabling restores access.
