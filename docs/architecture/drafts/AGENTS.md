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
| **Introduce an outbound third-party host** | CAP-068 / T-23. A CI guard is designed to fail the build on this |

---

## Before you change anything

1. **Read the relevant architecture document.** [README](../README.md) §1 gives the reading order.
2. **Check [18](../18-capability-traceability.md)** for the capability's mappings — modules, tables, ports, gate, and open questions.
3. **Check [19](../19-risks-and-decisions.md)** for whether the decision you are about to make is already made, pending, or yours.
4. **Check the invariants** in [01](../01-architecture-overview.md) §4.

## When you write

- **Match the surrounding document's structure and voice.** These documents are dense, tabular, and direct.
- **State what is not established** as prominently as what is. Every document ends with its unresolved validation.
- **Use stable IDs**: `CAP-###`, `FEAT-###`, `ENT-###`, `STM-###`, `SBX-###`, `PO-DEC-##`, `ADR-####`, `RISK-##`, `T-##`, `I-##`, `D-#`, `M-##`. **Never renumber an existing ID.**
- **Cross-reference with relative links** so the package stays navigable.

## When you validate

```bash
python3 docs/architecture/validate.py
```

**Write validation that asserts the brief's own requirements**, not generic checks. A validator that passes while a requirement is unmet is worse than none.

## When you are uncertain

**Say so in the document.** An acknowledged gap is a finding. An invented number, a guessed vendor schema, or a fabricated RPO target is a defect that will be trusted later precisely because it looks specific.
