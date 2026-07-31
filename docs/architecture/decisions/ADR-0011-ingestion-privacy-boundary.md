# ADR-0011 — Ingestion Privacy Boundary

**Status:** `PROPOSED` — 2026-07-31. Not accepted. **Implements the product-owner-approved decision PO-DEC-08.**

## Context

Hospital surgical-booking systems hold patient data. A scheduling product that ingests from them can easily accumulate patient-identifying information — and a workforce-scheduling system that holds patient data inherits clinical-system regulatory obligations without clinical-system controls.

**Contradiction C-09 is unresolved in both directions and stays that way.** The source publicly claims patient-identifying data is removed before upload; research separately observed clinical detail in the authenticated application. **These may not conflict** — the evidence never established which category the observed content fell into. **Nothing here asserts that the source did or did not hold patient-identifying information.**

SchedulePoint's obligation is discharged independently of that unresolved question. That is the point.

## Decision

**SchedulePoint owns and enforces the ingestion privacy boundary. Connector behaviour alone is never trusted.**

**A platform-controlled positive allowlist — never a deny-list.** A deny-list blocks the identifiers you thought of; an allowlist admits only the fields you deliberately chose, and rejects everything else including fields a vendor adds in a future release.

**Permitted:** work-item identity, location, timing, procedure **count** (a number, never a description), non-clinical operational category.
**Rejected or quarantined:** patient names, medical-record numbers, dates of birth, health-card identifiers, unrestricted clinical free text, and **any field not on the allowlist**.

**The boundary extends everywhere, not just to the primary table:** storage, logs, error payloads, queue payloads, audit events, observability, and — following from those — backups. **Quarantine stores field names and counts, never values**: enough for an operator to act, without becoming a store of exactly the data the boundary excludes.

**The boundary module (M-08) has no dependencies and no bypass.** The connector interface has no code path reaching work items without traversing it — a structural property, enforced by a contract test, not a convention.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Trust the connector to de-identify** | Makes the privacy posture depend on the least careful partner. A compromised or careless connector defeats it entirely |
| **Deny-list of known identifiers** | Fails on the identifier nobody anticipated, and on every field a vendor adds later |
| **Accept everything, redact on display** | The data is then *in* the system — in the database, in backups, in logs. Redaction at display solves nothing |
| **Quarantine full payloads for review** | Turns quarantine into the store the boundary exists to prevent |
| **Contractual controls only** | A contract is not a control |

## Consequences

**Positive:** patient data cannot enter, regardless of connector behaviour · **the regulatory surface is materially narrowed** · backups inherit the benefit because the data was never persisted · a compromised connector still cannot bypass it.

**Negative:** legitimate operational fields may be rejected until explicitly allowlisted, creating onboarding friction — **an acceptable cost, and the correct default** · every new field is a deliberate decision with a recorded rationale · quarantine triage is operational work.

## Security implications

Primary mitigation for T-14 (malicious import) and a major component of T-16 (connector compromise) and T-21 (backup exposure). **Routing is derived from the connection record, never from payload content**, so a payload cannot redirect itself into another tenant.

## Operational implications

Administrators are alerted on quarantine, rejection, and failure — **silent failure is prohibited**. Batches are atomic: a batch applies wholly or not at all. Idempotency is checked first, so re-delivery creates nothing. Dead-lettered batches are replayable after the cause is fixed.

## Capability mappings

CAP-062 directly; CAP-055, CAP-060, CAP-061, CAP-063, CAP-064, CAP-065 all depend on it.

## Gate mappings

`G-ARCH` — boundary design. **`G-CONN`** — certification. Test: **SBX-029**, using **fabricated** patient-shaped fields in expected *and* unexpected positions, asserting that **zero patient-level content persists anywhere, including logs**.

## Unresolved validation

- **SBX-029 has not been run. `G-CONN` cannot pass from documentation.**
- The allowlist's completeness for real operational needs is untested — no real payload has been seen, by design.
- **C-09 remains unproven in both directions and is not resolved by this ADR.**
