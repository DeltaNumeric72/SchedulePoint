# 15 — Audit and Observability

**Status: `PROPOSED`.** Implements CAP-027 and CAP-051.

> **REVISED 2026-08-01 (CAR-014).** **The claim that history "cannot be quietly rewritten" is withdrawn.** Withholding `UPDATE`/`DELETE` from the application role protects against application bugs and ordinary users only. The assurance level is now explicit — **A1 hash chaining with signed checkpoints, A2 external write-once replication, A3 notarisation deliberately not claimed** — with privileged-access auditing and three-way reconciliation. **"Retention is indefinite" is replaced** by an operable policy with legal hold and anonymisation. Governing spec: [SPEC-11](specs/SPEC-11-audit-assurance-and-security-boundaries.md), [ADR-0019](decisions/ADR-0019-audit-assurance-level.md).

---

## 1. Audit history

**Append-only by construction, not by convention.** No update or delete operation exists in the audit module, and the application role holds no such grant (D-8). **That is necessary and not sufficient (CAR-014):** migration owners, database owners, platform administrators, and restore tooling are unaffected by a grant. **Tamper *evidence* comes from the per-organization hash chain and signed checkpoints (D-25), and tamper *resistance against the platform itself* comes from external write-once replication.**

### 1.1 Every entry carries

| Field | Purpose |
|---|---|
| `actor_user_id` | **Who really acted** |
| `actor_membership_id` | In which group |
| **`on_behalf_of_membership_id`** | **When a proxy or impersonating operator acted — both parties named** |
| `organization_id`, `group_id` | Tenant scope |
| `action` | What was done |
| `subject_type`, `subject_id` | What it was done to |
| `before`, `after` | Previous and resulting state |
| `reason` | Required for overrides, denials, unlocking, and abandonment |
| `mechanism` | `ui` \| `picklist` \| `build` \| `api` \| `system` \| `import` |
| `source_channel` | Web, real-time, worker, connector |
| `correlation_id` | Ties a user action to every downstream effect |
| `occurred_at` | Timestamp |
| `version` | Aggregate version at the time |
| `affected_membership_ids` | Who was impacted — supports "what changed for me?" |

**`on_behalf_of` is not optional detail.** An audit entry attributing an operator's impersonated action to the impersonated user is worse than no entry — it actively misleads an investigation.

### 1.2 What must never appear in an audit payload

| Prohibited | Why |
|---|---|
| **Patient-identifying information** | I-07 — audit must not become the store other controls exclude |
| **Clinical free text** | Same |
| Credentials, tokens, secrets | Never, in any form |
| Full contact details | Reference the record; do not copy the value |
| Ingestion payload content | **Field names and counts only** |
| Notification message bodies | Reference the message; do not embed |

**`before`/`after` capture the fields that changed, by name, with values only for non-sensitive fields.** For sensitive fields the entry records *that* the field changed, not what it changed to.

### 1.3 What is audited

**Mandatory on every mutation:** assignments, schedule versions, credits, vacation selections, approvals, picks, capability grants, proxy authorizations.

**Mandatory on lifecycle transitions:** users, memberships, requests, builds, marketplace operations, picklists, calendar-feed tokens, entitlements.

**Mandatory on access:** document downloads, report generation and download, impersonation sessions.

**Configuration changes:** groups, shift types, rules, escalation policies — with a before/after diff.

### 1.4 Query and retention

Queryable by actor, subject, correlation id, time range, and affected membership — the source's per-cell log could not be queried in aggregate, which made it useful for one cell and useless for an investigation. **Retention is 7 years by default, then tenant policy, with legal hold and anonymisation-rather-than-deletion (CHANGED, CAR-014 — "indefinite" is not a lawful universal answer)**; partitioned by time when volume justifies. **Audit history must survive a restore intact, and chain verification after restore proves it or records the gap** (SBX-035).

---

## 2. Observability

### 2.1 Signals by area

| Area | Metrics | Logs | Traces | Alerts |
|---|---|---|---|---|
| **Web requests** | Rate, latency, error rate, **requests-per-interaction** | Structured, correlated | Full request span | Error-rate and latency thresholds |
| **Background jobs** | Queue depth, wait time, duration, failure rate | Per job with correlation | Enqueue → execute | Depth, age, dead-letter growth |
| **Solver runs** | Duration by dataset class, outcome distribution, **quality metrics**, violations by severity | Run summary; **never the full model** | Full run span | Timeout rate, infeasible rate, quality regression |
| **Notification delivery** | Attempts, outcomes, retry depth, dead-letters, **`no-destination` rate** | Per attempt (**no bodies**) | Event → intent → attempt | Failure rate, dead-letter growth, escalation exhaustion |
| **Real-time** | Connections, reconnects, message latency, stale-client count | Connect/disconnect, **authorization denials** | Command spans | Reconnect storms, subscription denials |
| **Picklist transitions** | Turn durations, timeouts, skips, interventions | Every transition | Turn lifecycle | Stalled list, deadlock |
| **Imports** | Batches by outcome, quarantine rate, reconciliation conflicts | **Metadata only — never payloads** | Batch span | Quarantine and failure rates |
| **Reports** | Generation duration, failures | Per run | Generation span | Failure rate |
| **Publication** | Publications, amendments, reverts, conflicts at sign-off | Per publication | Full transaction | Failed publications |
| **Authorization denial** | Denials by route, role, tenant | **Every denial** | — | **Anomalous spikes — possible probing** |
| **Suspicious activity** | Cross-tenant attempts, rate-limit trips, repeated failed auth | Security events | — | **Immediate** |

### 2.2 Correlation

**One correlation id flows from the originating user action through every downstream effect** — request → transaction → outbox → job → provider call → audit entry. It is stamped at the edge, propagated in job payloads and trace context, and recorded on audit entries.

Without it, "why did this person get three phone calls?" is not answerable.

### 2.3 Two metrics that enforce architectural invariants

| Metric | Enforces |
|---|---|
| **Requests-per-user-interaction** | **SP-HR-2 / I-10.** The observed source fired ~25–40 identical requests from a single click and had no way to notice. Tracking the ratio makes amplification visible; a CI budget makes it fail before release |
| **Real-time connections per active live feature** | Connections should scale with users needing live updates, **not with page views** — the source opened a connection on every page load, including pages with no live feature |

### 2.4 Log discipline

Structured JSON with correlation id, org id, group id, and actor on every line. **An allowlist of loggable fields, not a denylist** — the same reasoning as the ingestion boundary. Error reporting has scrubbing **enabled by default**. **Ingestion payloads and notification bodies are never logged.**

### 2.5 Dashboards

Operational health (error rate, latency, queue depth, dead-letters) · scheduling engine (duration, outcome, quality trend) · notification delivery (outcome distribution, `no-destination` trend) · picklist execution (active lists, turn duration, timeouts) · integrations (batch outcomes, quarantine) · security (authorization denials, rate-limit trips, cross-tenant attempts).

---

## 3. Capability and gate mapping

| Capability | Coverage |
|---|---|
| **CAP-027** Audit and affected-staff notification | §1 |
| **CAP-051** Observability, backup, recovery | §2 + [17](17-deployment-and-operations.md) §6 |

**ADR:** [ADR-0013](decisions/ADR-0013-audit-architecture.md). **Gates:** `G-PROD` — SBX-018, SBX-035. **Neither executed.**
