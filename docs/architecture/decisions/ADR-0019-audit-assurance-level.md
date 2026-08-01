# ADR-0019 — Audit Assurance Level

**Status:** `PROPOSED` — 2026-08-01. Not accepted. Raised by CAR-014.

## Context

The proposal claimed audit history "cannot be quietly rewritten" on the strength of withholding `UPDATE`/`DELETE` from the application role. That protects against application bugs and ordinary users and nothing else: migration owners, database owners, platform administrators, and restore tooling can all alter audit rows. There was no tamper-evidence, no external copy, no separation of duties, no privileged-read auditing, and no reconciliation between domain, outbox, and audit sequences. Separately, "retained indefinitely" collided with policy-driven deletion, personal-data requests, and legal obligation.

## Decision

**Name the assurance level explicitly and target A2.** A0 is application-enforced (the previous position). **A1 adds a per-organization hash chain with periodically signed checkpoints — targeted for `G-BETA`.** **A2 adds replication to write-once external storage in a separate trust domain — targeted for `G-PROD`.** A3 third-party notarisation is **deliberately not claimed**. Privileged sessions are themselves chained; domain, outbox, and audit sequences are continuously reconciled. **"Indefinite" is replaced by a 7-year default with tenant override, legal hold, and anonymisation-rather-than-deletion.** Full design: [SPEC-11](../specs/SPEC-11-audit-assurance-and-security-boundaries.md) §§1–4.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Keep A0 and keep the claim** | The claim was not supportable. This is the defect |
| **Keep A0 and drop the claim** | Honest but weak for a system that decides pay and time off |
| **A3 notarisation** | Protects against operator collusion, but needs a customer requirement and a cost decision that do not exist. **Not claimed** |
| **Hard deletion for personal-data requests** | Breaks the chain and destroys the record an audit trail exists to preserve. Anonymisation retains the pseudonymous actor instead

## Consequences

**Positive:** tampering becomes **detectable** rather than merely denied · a restore that truncates history is caught · a missing audit entry becomes an observable defect · retention is operable and lawful-shaped rather than a slogan.

**Negative:** chaining requires a per-organization serialisation point on the audit write path, which costs throughput on high-frequency paths such as picklist turns · external replication is a second storage cost and a second failure surface · **detection is not prevention, and an actor holding both database access and the signing key defeats A1 — which is precisely why A2 exists and why A3 is named as the limit**.

## Security implications

Mitigates T-19 and the new T-33 (privileged insider) and T-34 (support-tool exfiltration). Checkpoint signing keys live in a trust domain the application role cannot read. **Cloud-provider staff remain outside our control and are recorded as a residual risk rather than covered by an unsupported claim.**

## Operational implications

Chain verification runs after every migration and every restore. Corrective migrations touching protected tables require two-person approval and are audited. Legal hold suspends every retention job; release is two-person approved.

## Capability mappings

CAP-003, CAP-010, CAP-014, CAP-019, CAP-021–CAP-027, CAP-031–CAP-034, CAP-040, CAP-046, CAP-051, CAP-055.

## Gate mappings

`G-BETA` (A1), `G-PROD` (A2) — SBX-018, SBX-035. **Neither executed.**

## Unresolved validation

- Chain-write throughput on picklist paths is unmeasured.
- The external write-once store is gated on TDG-09 (object-lock support).
- **Whether anonymisation-with-retention satisfies any given jurisdiction is a legal determination that has not been made.**
- X-01..X-07 are unexecuted.
