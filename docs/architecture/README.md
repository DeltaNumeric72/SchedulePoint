# SchedulePoint Architecture Proposal

**Status: `PROPOSED`. Nothing here is approved, implemented, or verified.**

> **What this package is:** a complete architecture proposal covering all **58 production capabilities** in the SchedulePoint capability baseline.
>
> **What it is not:** an implementation, a scaffold, a migration set, a deployment, or an approval. **No application code exists. No test has been executed. No gate is passed. No ADR is accepted.**

---

## 1. Reading order

**If you are reviewing this for the first time, read in this order:**

| # | Document | Why here |
|---|---|---|
| 1 | [01 — Architecture overview](01-architecture-overview.md) | The recommended architecture and the **12 invariants** everything else obeys |
| 2 | [02 — Technology stack](02-technology-stack.md) | Every choice with alternatives, confidence, and a replacement boundary |
| 3 | [03 — System context and containers](03-system-context-and-containers.md) | External actors and the four process classes |
| 4 | [04 — Domain boundaries](04-domain-boundaries.md) | **25 modules in 6 layers**, and the dependencies that are prohibited |
| 5 | [05 — Tenancy, entitlements, authorization](05-tenancy-entitlements-authorization.md) | The four-layer model (**PO-DEC-02**, **PO-DEC-04**) |
| 6 | [06 — Data architecture](06-data-architecture.md) | Entities, tables, and the **database invariants D-1..D-10** |
| 7 | [07 — Schedule and publication](07-schedule-and-publication.md) | Ten distinct concepts, immutable versioning |
| 8 | [08 — Automated scheduling engine](08-automated-scheduling-engine.md) | `SolverPort`, build lifecycle, explainability, reproducibility |
| 9 | [09 — Requests, vacation, opportunities, transfers](09-requests-vacation-opportunities-transfers.md) | Typed requests and atomic claims |
| 10 | [10 — Picklist and real-time](10-picklist-and-realtime.md) | **PO-DEC-18.** The highest-concurrency, least-evidenced area |
| 11 | [11 — Notifications and communications](11-notifications-and-communications.md) | Four separated concepts; transactional outbox |
| 12 | [12 — Integrations and ingestion privacy](12-integrations-and-ingestion-privacy.md) | **PO-DEC-08.** The highest-consequence privacy boundary |
| 13 | [13 — Reports, calendars, documents](13-reports-calendars-and-documents.md) | The three surfaces where data leaves |
| 14 | [14 — Security and privacy](14-security-and-privacy.md) | **23 threats**, and an explicit statement of what is *not* claimed |
| 15 | [15 — Audit and observability](15-audit-and-observability.md) | Append-only audit; correlation; the two invariant-enforcing metrics |
| 16 | [16 — Testing and environments](16-testing-and-environments.md) | 39 sandbox tests, 12 environments, synthetic data only |
| 17 | [17 — Deployment and operations](17-deployment-and-operations.md) | Target operating model; **nothing provisioned** |
| 18 | [18 — Capability traceability](18-capability-traceability.md) | **All 58 capabilities**, each fully mapped |
| 19 | [19 — Risks and decisions](19-risks-and-decisions.md) | **26 risks**, 5 approved decisions, **18 retained pending decisions** |

**Supporting material:** [decisions/](decisions/) — 15 ADRs, all `PROPOSED` · [diagrams/](diagrams/) — Mermaid sources · [references/](references/) — verified primary technical sources · [drafts/](drafts/) — proposed agent-guidance files, **not installed** · [architecture-manifest.json](architecture-manifest.json) · [validate.py](validate.py).

**Short on time?** Read **01**, **19**, and this file's §4.

---

## 2. The four approved decisions this architecture rests on

| Decision | Substance |
|---|---|
| **PO-DEC-02** | Authorization: organization entitlement → group/module availability → membership role → explicit action capability. Deny-by-default. **No permission flag without a tested capability difference** |
| **PO-DEC-18** | Real-time: server-authoritative push for turn-critical picklist state; version tokens; reconnection and resync; visible staleness; explicit refresh fallback; page-scoped connections |
| **PO-DEC-04** | Entitlements: first-class org-level records separate from permissions; module dependencies; **disabling never deletes data**. *Technical architecture only* |
| **PO-DEC-08** | Ingestion privacy: **SchedulePoint owns and enforces the boundary** via a platform-controlled positive allowlist |

**Everything else remains a proposal. The 18 pending product decisions are retained with their working defaults in [19](19-risks-and-decisions.md) §2.2 — none has been approved.**

---

## 3. Clean-room boundary

This architecture was designed from a **behavioural** investigation of a comparable product. It contains **no proprietary source code, private API, algorithm, asset, copy, or database structure**.

| Discipline | Applied |
|---|---|
| **Source behaviour classified `UNRESOLVED` stays `UNRESOLVED`** | It is never converted into an asserted fact to make a design read better |
| **The source's scheduling algorithm is unknown** | It is not reproduced. SchedulePoint states its own model |
| **The source's real-time behaviour is unknown** | C-04 is unresolved; no claim is made about it |
| **C-09 is unproven in both directions** | Nothing asserts whether the source did or did not hold patient-identifying information |
| **No organization, site, or person from the research appears here** | Synthetic and placeholder references only |

Where the observed product exhibited a **defect** — an unrevocable calendar token, an irreversible vacation commit, a control that persisted a record on click, a hashed email sent to a third party, ~25–40 requests from one click, four accessibility failures — SchedulePoint's design closes it. **Closing an observed defect is independent design, not copying.**

---

## 4. What is not established

| Claim | Status |
|---|---|
| Any capability works | **Nothing is implemented** |
| Any test passes | **No test has been executed** |
| Any gate is met | **No gate is passed** |
| The architecture is sound | **No independent review has occurred** — a Codex architecture review is pending |
| Solver performance | **No benchmark has been run** |
| HIPAA / PHIPA / SOC 2 / ISO 27001 / GDPR | **No compliance claim is made.** [14](14-security-and-privacy.md) §11 lists the eight items such a claim would require, all marked *not done* |
| Named hospital connectors can be built | **Each requires an external specification not in hand** |
| RPO / RTO, cloud provider, region, data residency | **Open** |
| An incident-response plan exists | **It does not** |

---

## 5. Validation

```bash
python3 docs/architecture/validate.py
```

Checks structural completeness of this package — file presence, capability coverage, ADR status, link integrity, and the prohibitions this task operated under. **It validates documentation, not software.**
