# AGENTS.md — SchedulePoint (DRAFT — NOT INSTALLED)

> **This is a draft.** It has **not** been installed at the repository root.

Guidance for any automated agent working in this repository. It complements [CLAUDE.md](CLAUDE.md); where they overlap, they agree.

---

## Repository state

**Research and architecture only. No application code exists.**

```
schedulepoint-research/reports/   24 research reports + coverage audit
docs/architecture/                19 documents, 15 ADRs — all PROPOSED
```

---

## Hard prohibitions

| Never | Why |
|---|---|
| **Visit or interact with the source product** | Research is complete; the clean-room boundary is closed |
| **Reproduce proprietary code, APIs, algorithms, assets, copy, or schemas** | Clean-room integrity |
| **Convert `INFERRED` or `UNRESOLVED` into asserted fact** | The corpus's value is its honesty |
| **Drop a capability from the 58-capability baseline** | Scope is owner-controlled, not agent-controlled |
| **Mark an ADR accepted, a decision approved, or a gate passed** | Only the product owner does the first two; **only evidence does the third** |
| **Use real patient, staff, or customer data anywhere** | Including fixtures, screenshots, and logs |
| **Send a notification to a real destination** | Controlled endpoints only |
| **Claim HIPAA, PHIPA, SOC 2, ISO 27001, or GDPR compliance or readiness** | The required legal and operational work is explicitly not done ([14](../14-security-and-privacy.md) §11) |
| **Introduce an outbound third-party host *from the browser or client telemetry*** | **CAP-068 / T-23. This is the strict, absolute rule.** A CI guard fails the build on a new client host |
| **Add a server-side subprocessor without registering it** | **CORRECTED (CAR-023).** The previous blanket prohibition on *any* outbound host contradicted the email, SMS, voice, push, storage, identity, and observability providers the product requires. **Server-side processors are permitted when registered in the processor register with a declared payload schema, residency, and retention** ([SPEC-07](../specs/SPEC-07-notification-delivery-contracts.md) §7). **The client-side prohibition is unchanged and unconditional** |
| **Bypass the unit of work, RLS, an entitlement check, or a capability check** | I-15, I-19. Including "temporarily" |
| **Mutate a published schedule version or any of its child rows** | I-18 |
| **Delete an audit row or break the audit hash chain** | ADR-0019 |
| **Treat manual scheduling as the production mechanism** | I-05 |
| **Add a free-text field to a protected work-item path** | I-17 |
| **Weaken, skip, or delete an accessibility or architecture test** | Add tests; never subtract them |

---

## Before you change anything

1. **Read the relevant architecture document.** [README](../README.md) §1 gives the reading order.
2. **Check [18](../18-capability-traceability.md)** for the capability's mappings — modules, tables, ports, gate, and open questions.
3. **Check [19](../19-risks-and-decisions.md)** for whether the decision you are about to make is already made, pending, or yours.
4. **Check the invariants** in [01](../01-architecture-overview.md) §4.

## When you write

- **Match the surrounding document's structure and voice.** These documents are dense, tabular, and direct.
- **State what is not established** as prominently as what is. Every document ends with its unresolved validation.
- **Use stable IDs**: `CAP-###`, `FEAT-###`, `ENT-###`, `STM-###`, `SBX-###`, `PO-DEC-##`, `ADR-####`, `CAR-###`, `RISK-##`, `T-##`, `I-##`, `D-#`, `M-##`, `SPEC-##`, `TDG-##`, `OI-#`, `EV-#`. **Never renumber, reuse, or silently retire an existing ID.**
- **Every invariant ID means exactly one thing.** `I-05` is mandatory automated scheduling; the Add/New/Create save contract is **`I-13`**. The previous collision was finding CAR-023, and the validator now enforces uniqueness.
- **A decision ID that disappears from a register is a defect, not a decision.** `PO-DEC-10` was omitted from report 24 without a supersession record and has been restored as `pending` (CAR-016). If a decision is retired, record the supersession — **never reuse the number**.
- **Cross-reference with relative links** so the package stays navigable.

## When you validate

```bash
python3 docs/architecture/validate.py
```

**Write validation that asserts the brief's own requirements**, not generic checks. A validator that passes while a requirement is unmet is worse than none.

## When you are uncertain

**Say so in the document.** An acknowledged gap is a finding. An invented number, a guessed vendor schema, or a fabricated RPO target is a defect that will be trusted later precisely because it looks specific.
