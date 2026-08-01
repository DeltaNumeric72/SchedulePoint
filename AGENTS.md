# AGENTS.md — SchedulePoint

**Installed at the repository root.** Generated at M0 (OPUS-M0-002) from
[`docs/architecture/drafts/AGENTS.md`](docs/architecture/drafts/AGENTS.md) plus the
thirteen non-bypass rules in
[`docs/fable/17-opus-agent-runbook.md`](docs/fable/17-opus-agent-runbook.md) §1. The drafts
remain in place, unmodified.

Guidance for any automated agent working in this repository. It complements
[CLAUDE.md](CLAUDE.md); where they overlap, they agree.

---

## Repository state

Research, architecture, and a repository scaffold. **No product feature code, no
migrations, no domain logic.**

```
schedulepoint-research/reports/   24 research reports + coverage audit
docs/architecture/                19 documents, 23 ADRs, 16 SPECs — all PROPOSED
docs/fable/                       specification, plans, roadmap, task packets
spikes/                           executed spikes and reports (evidence, not production)
apps/ packages/ solver/           scaffold skeletons + the CI gate battery
```

---

## The thirteen non-bypass rules

Quoted **verbatim** from the runbook ([17](docs/fable/17-opus-agent-runbook.md) §1):

> **Thirteen non-bypass rules (from the linted drafts, binding):** never bypass the
> unit-of-work; never use session-scoped `SET` for tenant context; never disable/bypass
> RLS; never skip entitlement or capability checks; never mutate a published version;
> never write audit rows outside the chain; never treat manual scheduling as the
> production mechanism; never add free text to protected ingestion paths; never log
> delivery material or payload bodies; never weaken/skip accessibility or architecture
> tests; never expand capability scope; never implement a pending decision's non-default
> branch; never remove or renumber a stable ID.

As a checklist:

1. never bypass the unit-of-work
2. never use session-scoped `SET` for tenant context
3. never disable/bypass RLS
4. never skip entitlement or capability checks
5. never mutate a published version
6. never write audit rows outside the chain
7. never treat manual scheduling as the production mechanism
8. never add free text to protected ingestion paths
9. never log delivery material or payload bodies
10. never weaken/skip accessibility or architecture tests
11. never expand capability scope
12. never implement a pending decision's non-default branch
13. never remove or renumber a stable ID

CLAUDE.md carries the same thirteen with their reasons and the gate that enforces each.

---

## Hard prohibitions

| Never                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Visit or interact with the source product**                                     | Research is complete; the clean-room boundary is closed                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Reproduce proprietary code, APIs, algorithms, assets, copy, or schemas**        | Clean-room integrity                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Convert `INFERRED` or `UNRESOLVED` into asserted fact**                         | The corpus's value is its honesty                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Drop a capability from the 58-capability baseline**                             | Scope is owner-controlled, not agent-controlled                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Mark an ADR accepted, a decision approved, or a gate passed**                   | Only the product owner does the first two; **only evidence does the third**                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Use real patient, staff, or customer data anywhere**                            | Including fixtures, screenshots, and logs                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Send a notification to a real destination**                                     | Controlled endpoints only                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Claim HIPAA, PHIPA, SOC 2, ISO 27001, or GDPR compliance or readiness**         | The required legal and operational work is explicitly not done ([14](docs/architecture/14-security-and-privacy.md) §11)                                                                                                                                                                                                                                                                                                                                                                        |
| **Introduce an outbound third-party host _from the browser or client telemetry_** | **CAP-068 / T-23. This is the strict, absolute rule.** A CI guard fails the build on a new client host                                                                                                                                                                                                                                                                                                                                                                                         |
| **Add a server-side subprocessor without registering it**                         | **CORRECTED (CAR-023).** The previous blanket prohibition on _any_ outbound host contradicted the email, SMS, voice, push, storage, identity, and observability providers the product requires. **Server-side processors are permitted when registered in the processor register with a declared payload schema, residency, and retention** ([SPEC-07](docs/architecture/specs/SPEC-07-notification-delivery-contracts.md) §7). **The client-side prohibition is unchanged and unconditional** |
| **Bypass the unit of work, RLS, an entitlement check, or a capability check**     | I-15, I-19. Including "temporarily"                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Mutate a published schedule version or any of its child rows**                  | I-18                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Delete an audit row or break the audit hash chain**                             | ADR-0019                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Treat manual scheduling as the production mechanism**                           | I-05                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Add a free-text field to a protected work-item path**                           | I-17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Weaken, skip, or delete an accessibility or architecture test**                 | Add tests; never subtract them                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## Before you change anything

1. **Read the relevant architecture document.**
   [README](docs/architecture/README.md) §1 gives the reading order.
2. **Check [18](docs/architecture/18-capability-traceability.md)** for the capability's
   mappings — modules, tables, ports, gate, and open questions.
3. **Check [19](docs/architecture/19-risks-and-decisions.md)** for whether the decision
   you are about to make is already made, pending, or yours.
4. **Check the invariants** in [01](docs/architecture/01-architecture-overview.md) §4.
5. **Read your task packet's Allowed/Prohibited paths.** Research reports are always
   prohibited. A diff outside the allowed globs is a rejection, however good the code.

---

## When you write code

### Layering — enforced, not advisory

```
packages/domain     imports NOTHING     (no framework, no driver, no node builtin)
packages/contracts  imports zod
apps/api            imports domain + contracts
apps/web            imports contracts
```

`.dependency-cruiser.cjs` blocks the wrong direction; `scripts/red-cases/import-boundary/`
proves it blocks it.

### Every route declares a policy

`apps/api` registers routes through auto-discovery, and an `onRoute` hook records every
one. A route without `config.policy` fails `pnpm check` and refuses to boot (I-02).

### Every wire shape is a zod contract

`packages/contracts` is the only definition of what crosses the API boundary. Objects are
`.strict()` so unknown keys are rejected rather than carried (I-07 alignment).

### Every tenant table carries RLS in the migration that creates it

Same file: `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and at least one
policy. `scripts/gates/migration-rls-check.mjs` fails the build otherwise. RLS predicates
are spelled `nullif(current_setting('app.<x>', true), '')::uuid` — the setting is `NULL`
_or_ `''` (SPIKE-REPORT §6.1).

### Tenant context is established with `set_config(name, value, true)`

Never any `SET` form. The `SET` forms cannot be parameterised, so writing one means
interpolating the tenant id into SQL — an injection surface at the most security-critical
statement in the system. ESLint rejects it.

### One user action, one request

I-10 / SP-HR-2. New interactions get a budget in
`scripts/gates/request-budget/budgets.json` and a recording from the Playwright run. A
budgeted interaction with **no** recording fails the gate; the measurement cannot be
skipped by breaking the browser run.

---

## When you write documents

- **Match the surrounding document's structure and voice.** These documents are dense,
  tabular, and direct.
- **State what is not established** as prominently as what is. Every document ends with
  its unresolved validation.
- **Use stable IDs**: `CAP-###`, `FEAT-###`, `ENT-###`, `STM-###`, `SBX-###`, `PO-DEC-##`,
  `ADR-####`, `CAR-###`, `RISK-##`, `T-##`, `I-##`, `D-#`, `M-##`, `SPEC-##`, `TDG-##`,
  `OI-#`, `EV-#`. **Never renumber, reuse, or silently retire an existing ID.**
- **Every invariant ID means exactly one thing.** `I-05` is mandatory automated
  scheduling; the Add/New/Create save contract is **`I-13`**. The previous collision was
  finding CAR-023, and `scripts/gates/invariant-id-uniqueness.mjs` now enforces
  uniqueness on every build.
- **A decision ID that disappears from a register is a defect, not a decision.**
  `PO-DEC-10` was omitted from report 24 without a supersession record and has been
  restored as `pending` (CAR-016). If a decision is retired, record the supersession —
  **never reuse the number**.
- **Cross-reference with relative links** so the package stays navigable.

---

## When you validate

```bash
corepack pnpm check       # the twelve build-failing gates
corepack pnpm red-cases   # proof that each gate still fails on its violation
python3 docs/architecture/validate.py
```

**Write validation that asserts the brief's own requirements**, not generic checks. A
validator that passes while a requirement is unmet is worse than none. A gate that has
only ever been seen passing is not evidence — that is why every gate ships with a red
case.

---

## When you report

Implementation summary · files changed · **architecture deviations (or "none")** · tests
created · commands run **with actual output** · test results · browser verification (what
was exercised, at which viewports) · security considerations · accessibility
considerations · known limitations · unresolved questions · suggested follow-ups.

**A return without command output is treated as unverified.**

## When you are uncertain

**Say so.** An acknowledged gap is a finding. An invented number, a guessed vendor
schema, or a fabricated RPO target is a defect that will be trusted later precisely
because it looks specific.

**Escalation is success behaviour.** Stop and report rather than improvise.
