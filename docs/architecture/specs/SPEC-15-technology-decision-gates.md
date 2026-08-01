# SPEC-15 — Technology Decision Gates

**Status: `PROPOSED`.** Remediates **CAR-024** (Medium).
**Supersedes:** [02](../02-technology-stack.md) `VERIFY` rows as previously stated.

> **What was wrong.** "Mature TypeScript framework," "ORM or query builder," queue library, authentication implementation, notification providers, report renderer, calendar generator, object-store product, hosting platform, and several observability components were unselected or marked `VERIFY` — yet the stack was described as chosen and ADR-0002 was treated as a decision. Fitness, maintenance, licensing, security response, deployment, residency, and replacement cost could not be reviewed. **A port is a seam; it does not neutralise provider data formats, callback semantics, SQL behaviour, or operational lock-in.**

---

## 1. What is decided and what is not

| Decided (verified primary source) | Undecided (gated below) |
|---|---|
| PostgreSQL as transactional store (S-03, S-03b) | PostgreSQL **product and hosting** |
| OR-Tools CP-SAT, Apache-2.0 (S-01, S-02) | — |
| **Python** solver runtime (S-04) | Python distribution and base image |
| Web Push delivery material (S-05) | Push provider path |
| WebSocket transport | WebSocket library |
| S3-compatible interface | Object-store **product** |
| Node.js LTS for classes 1–3, 6 | **Web framework, ORM, queue library** |
| OpenTelemetry | Backend |
| Playwright, axe-core | — |

**The stack is not "selected." It is partly decided and partly gated, and this document says which is which.**

---

## 2. Gate contract

**Each `TDG-nn` must be closed before the work it blocks begins. Closing a gate produces a decision record with: product, version, licence, maintenance and security-response policy, deployment and residency constraints, local-development approach, failure behaviour, replacement boundary, and a spike result.**

| # | Decision | Blocks | Must resolve |
|---|---|---|---|
| **TDG-01** | **Web framework** | Any route work | Middleware composition for context and authorization; streaming for large artifacts; **build-time route enumeration** for the undeclared-route check ([SPEC-06](SPEC-06-authorization-truth-table.md)) |
| **TDG-02** | **Data-access layer (ORM / query builder)** | **Any schema work** | **Must reliably issue `SET LOCAL` inside a caller-controlled transaction** ([SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) §4.2); express exclusion constraints, partial unique indexes, triggers, and `FOR UPDATE`; no hidden connection checkout outside the unit of work |
| **TDG-03** | **Connection pooler mode** | Any schema work | **Statement-level pooling is prohibited** (S-03b). Session or transaction pooling with transaction affinity, proven by the [SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) T-14 harness |
| **TDG-04** | **Queue library** | Any job work | Durable claims with **leases**, priority separation, dead-letter, and **transactional enqueue in the domain transaction** ([ADR-0009](../decisions/ADR-0009-job-and-event-reliability.md)) |
| **TDG-05** | **AuthN / OIDC implementation** | Identity work | Issuer pinning, `nonce`, account-linking control (T-26, T-27), MFA, session rotation |
| **TDG-06** | **Notification providers** (email, SMS, voice, push) | Delivery work | **Per-provider capability declaration** ([SPEC-07](SPEC-07-notification-delivery-contracts.md) §4.3): idempotency, receipts, status query, signed callbacks. **Residency and a data-processing agreement per provider** |
| **TDG-07** | **Report renderer** | Report work | **Must not execute untrusted HTML or fetch remote resources**; deterministic output; resource-bounded |
| **TDG-08** | **Calendar (iCalendar) generator** | Feed work | RFC 5545 conformance; timezone correctness; consumer compatibility matrix |
| **TDG-09** | **Object store** | Artifact work | Versioning, **object-lock** (for [SPEC-11](SPEC-11-audit-assurance-and-security-boundaries.md) §3.1), signed URLs with short expiry, encryption, replication |
| **TDG-10** | **Malware scanning** | Document work | Fail-closed, bounded decompression, quarantine |
| **TDG-11** | **Hosting platform** | Provisioning | [SPEC-10](SPEC-10-deployment-topology.md) §2 requirements; **three images**; long-lived WebSockets; CPU-optimised solver pool |
| **TDG-12** | **Observability backend** | Telemetry | **Redaction before egress**; residency; retention |
| **TDG-13** | **Secret store** | Any credential | Envelope encryption, versioned keys, **separate trust domains** ([SPEC-11](SPEC-11-audit-assurance-and-security-boundaries.md) §6) |
| **TDG-14** | **UI component library** | UI foundations | **Must satisfy [SPEC-14](SPEC-14-accessibility-acceptance-matrix.md) by default.** A library that fights accessible defaults is disqualified regardless of other merit |
| **TDG-15** | **Audit checkpoint signing service** | A1 assurance | Key isolation from the application role |

---

## 3. Required spikes

Each is a **bounded proof**, not a prototype of the product.

| Spike | Proves | Gates |
|---|---|---|
| **SP-1 RLS + data layer** | `SET LOCAL` under the chosen ORM and pooler; fail-closed outside the unit of work; pool-reuse isolation | TDG-02, TDG-03 |
| **SP-2 Constraint expressiveness** | Exclusion constraints, partial unique indexes, and triggers ([SPEC-05](SPEC-05-schedule-version-identity-and-publication.md), [SPEC-02](SPEC-02-picklist-turn-transaction.md)) expressible and migratable | TDG-02 |
| **SP-3 Queue leases** | Claim, lease expiry, re-claim, dead-letter, transactional enqueue | TDG-04 |
| **SP-4 WebSocket scale** | Target concurrent connections per instance; reconnect storm behaviour | TDG-11 |
| **SP-5 Solver boundary** | Serialise a `B-medium` problem, solve, **cancel**, time out, **kill**, restart, reproduce | TDG-11 |
| **SP-6 Provider callbacks** | Per provider: signature verification, replay rejection, idempotency behaviour | TDG-06 |
| **SP-7 Report sandbox** | Renderer cannot fetch remote resources or execute injected script | TDG-07 |
| **SP-8 iCalendar compatibility** | Feed renders correctly across common consumers | TDG-08 |
| **SP-9 Object store** | Signed URLs, versioning, **object-lock**, replication | TDG-09 |
| **SP-10 Telemetry redaction** | No payload, contact value, or delivery material leaves the process | TDG-12 |

---

## 4. Standing rules

| Rule | Detail |
|---|---|
| **No `VERIFY` row may be described as decided** | [02](../02-technology-stack.md) marks each as `GATED (TDG-nn)` |
| **Each gate carries a review-by date** | Re-examined if unresolved by then |
| **Licence and maintenance recorded at closure** | Not afterwards |
| **Replacement boundary stated at closure** | What changes if it must be swapped |
| **A gate closed without its spike is reopened** | The spike is the evidence |

---

## 5. Traceability

**Capabilities:** CAP-008, CAP-015, CAP-032, CAP-040, CAP-041, CAP-046, CAP-047, CAP-048, CAP-051, CAP-066, CAP-067.
**Decisions:** PO-DEC-07, PO-DEC-09, PO-DEC-21, PO-DEC-22, PO-DEC-23 — **all pending.**
**ADRs:** [ADR-0002](../decisions/ADR-0002-primary-technology-stack.md) (revised), [ADR-0010](../decisions/ADR-0010-notification-architecture.md), [ADR-0014](../decisions/ADR-0014-file-and-report-storage.md), [ADR-0015](../decisions/ADR-0015-deployment-topology.md).
**Gates:** `G-ARCH`, `G-BETA`, `G-PROD`. **None passed. No TDG is closed.**
