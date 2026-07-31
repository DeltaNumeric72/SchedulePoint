# ADR-0012 — Connector Architecture

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

## Context

The source product publicly names integrations with ORSOS, Cerner/Surginet, and Meditech. **The research established that these systems are named; it did not establish their payload shapes.** No vendor specification is in hand for any of them.

Two commercial realities shape this decision. Hospital IT integration timelines are long and outside our control. And inventing a payload schema would produce a connector that fails on first contact with reality while misrepresenting guesswork as design.

## Decision

**A three-layer architecture with a platform-owned canonical import schema in the middle.**

1. **Connector adapter** — vendor-specific; translates an external payload into the canonical schema.
2. **Canonical import schema** — **platform-owned. Connectors adapt to it; it never adapts to them.**
3. **Ingestion privacy boundary** (ADR-0011) — platform-owned, dependency-free, unbypassable.

A connector's interface is `fetch()` or `receive()` → canonical payload, **and nothing else**. A connector cannot write work items directly.

**Credentials are never stored on the connection record** — an `auth_ref` points to a managed secret store. Imports are idempotent on `(connection_id, idempotency_key)`. Every imported work item carries `import_batch_id` and `origin = imported`. Connector versions are recorded with a schema reference and a certification record.

**No connector ships without passing `G-CONN` certification**: external specification obtained, canonical mapping reviewed field by field with the allowlist decision recorded per field, SBX-028 (import validation) and **SBX-029 (de-identification)** passed, fabricated fixtures only, customer privacy-office approval where applicable, and a documented failure and reconciliation runbook.

**Named connectors carry the disposition `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION`. This is not a deferral — it is a dependency on a document we do not have.**

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Per-vendor schemas end to end** | Every vendor's shape leaks into the domain; the boundary would need re-implementing per connector |
| **Invent the vendor schemas now** | Would fail on first contact with a real system and would present guesswork as design |
| **Let connectors write work items directly** | Defeats ADR-0011 entirely |
| **Third-party integration platform** | Moves the privacy boundary outside our control — the exact thing PO-DEC-08 rejects |

## Consequences

**Positive:** **no hospital's IT timeline gates SchedulePoint's own release** — a missing specification blocks that connector, not the product · the domain sees one shape · new connectors are additive · certification is a repeatable gate.

**Negative:** canonical-schema evolution must stay backward-compatible across connectors · a vendor whose model does not map cleanly forces a hard conversation · certification is real work per connector.

## Security implications

T-16 (connector compromise): the connector **cannot bypass the boundary**; routing comes from the connection record, never from payload content; credentials live in a secret store and are never logged. Sync scheduling uses jitter to avoid synchronised load.

## Operational implications

Scheduled synchronization per connection with manual, idempotent retry. Metrics: batches by outcome, quarantine rate, reconciliation conflicts. **Logs carry metadata only — never payloads.** Reconciliation never silently destroys manually-created work items; conflicts quarantine for human review, and an item that disappears from the source is marked withdrawn rather than deleted — it may already have been picked.

## Capability mappings

CAP-055, CAP-061, CAP-063, CAP-064, CAP-065, CAP-060.

## Gate mappings

`G-ARCH` — CAP-055 (framework). **`G-CONN`** — CAP-061..CAP-065. Tests: SBX-028, SBX-029. **Environment: INTEG.**

## Unresolved validation

- **No vendor payload contract exists for any named connector.**
- SBX-028 and SBX-029 have not been executed.
- Whether the canonical schema is expressive enough for real hospital payloads is unknown until a specification arrives.
