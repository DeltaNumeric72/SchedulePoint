# ADR-0014 — File, Report, and Calendar-Feed Storage

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

> **REVISED 2026-08-01 (CAR-012, CAR-019).** Reports now bind an **immutable input snapshot** declared per report class, are **re-authorized at execution and at every download**, and support membership-scoped shares with immediate revocation ([ADR-0018](ADR-0018-report-snapshot-semantics.md), [SPEC-09](../specs/SPEC-09-report-snapshot-and-artifact-authorization.md)). Object-store product selection is gated (TDG-09), and **object-lock support is now a hard requirement** because [SPEC-11](../specs/SPEC-11-audit-assurance-and-security-boundaries.md) §3.1 depends on it.

## Context

Three surfaces put schedule data outside the authenticated application: generated reports, uploaded documents, and calendar feed subscriptions. Each is a way for data to leave, and each needs its own answer to "who can get this, and for how long?"

The research recorded a calendar feed token in the source product with **no observed revocation or rotation path**. A subscription URL is pasted into calendar clients, forwarded, and synced to devices — an unrevocable one is a permanent exposure.

## Decision

**S3-compatible object storage with per-tenant key prefixes, no public objects, and short-lived signed URLs. Access is re-checked at download, not only at generation.**

| Surface | Design |
|---|---|
| **Reports** | Generated asynchronously under the requester's context; artifacts expire by default; **authorization re-checked at download** — a report generated last week must not be retrievable by someone who lost access since |
| **Documents** | Visibility level enforced server-side per document; **malware-scanned before becoming available**; versioned; purge invalidates URLs |
| **Calendar feeds** | Tokens are **hash-stored, revocable, rotatable, single-membership, and read-only**. **No PII in the URL.** The owner is notified on issue, rotation, and revocation |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Database blob storage** | Bloats backups, complicates streaming, and couples file lifecycle to schema migrations |
| **Public objects with unguessable names** | Security by obscurity. A forwarded URL is permanent access |
| **Long-lived signed URLs** | Same failure with extra steps |
| **Authorize at generation only** | A revoked user retains access to everything generated before revocation |
| **Non-revocable feed tokens** (the observed source behaviour) | A leaked URL is a permanent schedule exposure with no remedy |

## Consequences

**Positive:** files never leave tenant-scoped access · a leaked URL expires · calendar-feed exposure is remediable · large artifacts stay out of the database.

**Negative:** an object-storage dependency to operate and secure · signed-URL expiry occasionally frustrates users mid-download · malware scanning adds latency between upload and availability · token rotation requires users to re-subscribe.

## Security implications

Mitigates T-09 (calendar-token leakage), T-10 (report leakage), and T-11 (document leakage). Per-tenant prefixes mean a misconfigured policy has a bounded blast radius. Storage is encrypted at rest. **Reports and calendar feeds carry no clinical content**, and the on-call feed carries minimum-necessary fields only.

## Operational implications

Artifact expiry and purge jobs. Versioned, replicated buckets. Scan failures must block availability rather than fail open. **A calendar-token-compromise runbook is required and does not exist.**

## Capability mappings

CAP-046 (reports), CAP-047 (calendar feeds), CAP-048 (documents), CAP-044 (on-call access), CAP-020 (schedule views and printing).

## Gate mappings

`G-BETA` — CAP-047. `G-PROD` — CAP-044, CAP-046, CAP-048. Tests: SBX-031a, SBX-031b, SBX-031c.

## Unresolved validation

- SBX-031a/b/c have not been executed.
- PO-DEC-22 (document retention) is pending.
- The malware-scanning provider is unchosen.
- Report generation latency at scale is unmeasured.
