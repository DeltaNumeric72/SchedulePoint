# ADR-0010 — Notification Architecture

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

## Context

Notification is load-bearing for this product: a picklist turn depends on reaching someone who may not be at a screen, and a schedule change must reach the people it affects. The research also observed accounts with **no phone number** — a voice channel with nothing to dial, and no signal that anything was wrong.

The failure mode to design against is not "notification is hard" but "nobody can answer whether it was sent, to whom, on which channel, and what happened."

## Decision

**Four separated concepts, never collapsed:**

| Concept | Is | Owned by |
|---|---|---|
| **Domain event** | A fact that happened | The domain module |
| **Notification intent** | A decision that someone should be told | Notification Delivery |
| **Rendered message** | Content for one recipient on one channel | Notification Delivery |
| **Delivery attempt** | One try on one channel, with an outcome | Notification Delivery |

**A domain module emits facts. It never decides who to notify, never renders content, and never calls a provider.** That is what makes notification delivery extractable without touching a domain module.

Every channel — email, SMS, automated voice, push, in-app — sits behind a **port**. Escalation uses two ladders (business hours and personal hours), selected by the recipient's local time against the group timezone, with group defaults and per-user overrides.

**`no-destination` is an explicit delivery outcome**, never a silent skip. Suppression is **recorded, never silent** — a silently suppressed escalation is indistinguishable from a delivery failure.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Domain modules send directly** | Couples every domain to every provider; makes extraction impossible; scatters retry logic |
| **Collapse intent and message** | Cannot express "one decision, three channels, five attempts" |
| **Collapse message and attempt** | Loses retry history — the exact thing an operator needs during an incident |
| **Third-party notification platform** | Attractive, but escalation policy is product logic, and delivery records are needed inside the product's audit surface. Providers stay behind ports |
| **Silent skip when no contact exists** | Makes a data-quality problem invisible. Hence `no-destination` |

## Consequences

**Positive:** "was it sent, to whom, and did it arrive?" is answerable · providers are swappable at the adapter · the `no-destination` rate becomes an operational health metric showing roster decay · delivery is decoupled from action (notified by voice, act from a desktop).

**Negative:** four concepts to model and store · delivery-attempt volume grows quickly and needs partitioning · templates must be versioned so a received message can be reconstructed.

## Security implications

T-12 (notification abuse / phishing): **recipients resolve only from the roster — never from free text**, broadcasts are rate-limited and audited with actor and recipient count, and sender identity is unambiguous so the product does not become a phishing vector from a trusted domain. **No clinical content in message bodies; no PII in URLs** — deep links carry opaque identifiers and the recipient authenticates. Bounces and opt-outs are recorded against a **hashed** contact value.

## Operational implications

Metrics: attempts, outcome distribution, retry depth, dead-letters, escalation exhaustion, `no-destination` rate. **Message bodies are never logged.** Escalation exhaustion raises an operational alert rather than passing silently.

## Capability mappings

CAP-040, CAP-041, CAP-042, CAP-043, CAP-056; consumed by CAP-014, CAP-024, CAP-026, CAP-027, CAP-031.

## Gate mappings

`G-BETA` — CAP-042. `G-PROD` — CAP-040, CAP-041, CAP-043, CAP-056. Tests: SBX-030a, SBX-030b — **all against controlled endpoints; no real person is ever contacted.**

## Unresolved validation

- **C-10:** push is publicly claimed by the source but absent from its application. **No removal is asserted.** PO-DEC-07 pending.
- **C-11:** the source's group email address has no application field; most plausibly out of band — **unproven**. PO-DEC-21 pending.
- SMS and voice jurisdictional rules are a compliance question that has not been assessed.
- **C-06:** the source's directory filter remains `UNRESOLVED`; SchedulePoint replaces it with an explicit policy (PO-DEC-20 pending).
