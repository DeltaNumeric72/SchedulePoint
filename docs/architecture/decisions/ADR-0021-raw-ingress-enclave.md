# ADR-0021 — Raw-Ingress Enclave

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-004. **Implements the approved PO-DEC-08 more faithfully than the previous design did.**

## Context

The previous flow was `source → connector adapter → canonical DTO → boundary`. Everything before the boundary is ordinary application infrastructure: TLS termination, an HTTP body buffer, a JSON parser, adapter code, process memory, exception objects, APM spans, retry queues, and crash dumps. **The raw payload was already inside the platform, and inside its observability, before the "boundary" saw it.**

PO-DEC-08 says SchedulePoint owns and enforces the ingestion privacy boundary. A boundary that sits downstream of logging, tracing, error capture, and durable queues does not discharge that decision.

## Decision

**Terminate the external connection inside a minimal, separately packaged ingress enclave, and let only constrained-schema-validated values leave it.**

The enclave: **no body logging; no payload tracing; no error-reporting SDK in the image; no core dumps or heap snapshots; read-only root filesystem with a single `tmpfs` buffer; no durable queue and no dead-letter payload; no database credential; egress allowlisted to the source and the platform ingress API only; its own image, SBOM, and patch stream.**

**Replay re-fetches from the source. It never replays a stored body.**

Full design: [SPEC-03](../specs/SPEC-03-raw-ingress-trust-boundary.md) §3.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Boundary as an application module** | The status quo. Inherits the application's logging, tracing, error capture, and crash behaviour — the defect |
| **Scrub logs and traces downstream** | Requires knowing every field that might carry an identifier. Same unprovable assumption the key allowlist made |
| **Trust connectors to de-identify** | Explicitly rejected by PO-DEC-08 |
| **Terminate at a shared API gateway** | A shared gateway logs and traces by default and is not ours to constrain per-route with confidence |
| **Accept payloads and redact at rest** | The data is then in the database, the backups, and the logs. Redaction at display solves nothing |

## Consequences

**Positive:** raw payloads cannot reach durable storage or telemetry, because the components that would carry them are absent from the image · a compromised connector still cannot bypass the boundary · backups inherit the property, because the data was never persisted.

**Negative:** **a fifth process class and a third image** · debugging an import failure is deliberately harder — an operator sees field paths, codes, and counts, never values, and **that cost is accepted knowingly** · the enclave is a new availability dependency for imports · memory scrubbing between batches is **best-effort on a managed runtime, and is stated as best-effort rather than guaranteed**.

## Security implications

Primary mitigation for T-14 (malicious import), T-29 (SSRF — the egress allowlist), and the new T-38 (enclave compromise). The enclave holds no database credential, so compromise yields no tenant data at rest. Routing is derived from the connection record, never from payload content, so a payload cannot redirect itself into another tenant.

## Operational implications

Separate deploy, scale, and patch cadence. Enclave loss stops imports and persists nothing partial; sources re-send or are re-fetched. **An enclave-compromise runbook is required and does not exist.** Configuration attestation (E-1..E-12) is part of connector certification.

## Capability mappings

CAP-055, CAP-060, CAP-061, CAP-062, CAP-063, CAP-064, CAP-065, CAP-068.

## Gate mappings

`G-ARCH`, **`G-CONN`**, `G-PROD` — SBX-028, SBX-029. **Neither executed.**

## Unresolved validation

- **SBX-029's whole-platform canary sweep requires restorable-backup access (EV-2) and error-reporting vendor API access (EV-3), neither of which exists. `G-CONN` cannot pass until they do.**
- No vendor payload specification is in hand for any named connector (EV-1).
- I-01..I-12 in [SPEC-03](../specs/SPEC-03-raw-ingress-trust-boundary.md) §10 are unexecuted.
