# ADR-0013 — Audit Architecture

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

## Context

A workforce-scheduling system makes decisions that affect people's pay, time off, and family arrangements. When a decision is disputed months later, the question is always the same: **who did this, when, why, and what did it change?**

The research recorded that the source product's change log was per-cell — useful for one schedule cell, and useless for an investigation, because it could not be queried in aggregate. It also recorded proxy and administrative actions where attribution mattered.

## Decision

**Append-only audit by construction, not by convention.** No update or delete operation exists in the audit module, and the application database role holds no such grant.

Every entry records: **actor**, **actor membership**, **`on_behalf_of_membership_id`**, organization, group, action, subject type and id, `before`/`after`, `reason`, `mechanism`, `source_channel`, **`correlation_id`**, timestamp, aggregate version, and **`affected_membership_ids`**.

**`on_behalf_of` is not optional detail.** An entry attributing an impersonated or proxied action to the wrong party is worse than no entry — it actively misleads an investigation.

**One correlation id flows from the originating user action through every downstream effect** — request → transaction → outbox → job → provider call → audit entry. Without it, "why did this person get three phone calls?" is unanswerable.

**Prohibited in any audit payload:** patient-identifying information, clinical free text, credentials or tokens, full contact details, ingestion payload content (field names and counts only), notification message bodies. For sensitive fields, the entry records *that* the field changed, not what it changed to.

**Queryable by actor, subject, correlation id, time range, and affected membership. Retention is indefinite.**

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Per-cell change log** (the source's approach) | Cannot answer an aggregate question. Useful for one cell, useless for an investigation |
| **Application-enforced immutability** | Depends on every future code path being careful. **Withholding the grant does not** |
| **Event sourcing as the audit trail** | Conflates the domain's storage model with its accountability record; a domain refactor would rewrite history |
| **Log-file audit** | Not queryable, not tenant-scoped, and log retention policies would silently destroy it |
| **Full `before`/`after` for every field** | Turns the audit trail into a store of exactly the sensitive data other controls exclude |

## Consequences

**Positive:** history cannot be quietly rewritten · proxy and impersonated actions name both parties · correlation ids make cause-and-effect traceable across processes · aggregate queries are possible.

**Negative:** volume grows continuously and requires time partitioning · every mutation path must write an entry, and a missing entry is a silent gap · indefinite retention has a storage cost.

## Security implications

Primary mitigation for T-19 (audit tampering). Audit read requires an explicit capability; **audit is never mutable by anyone, including a platform administrator**. **Restore rehearsal verifies that audit history survives recovery intact** — an audit trail that does not survive a restore is not an audit trail.

## Operational implications

Time partitioning as volume grows. Audit is a support tool as much as a compliance one: most "why did this happen?" questions resolve there. **Nothing is ever deleted from it.**

## Capability mappings

CAP-027, CAP-051 directly; CAP-010, CAP-019, CAP-033, CAP-034 depend on its attribution guarantees; every mutating capability writes to it.

## Gate mappings

`G-PROD` — CAP-027, CAP-051. Tests: SBX-018, **SBX-035** (audit integrity after restore).

## Unresolved validation

- SBX-018 and SBX-035 have not been executed.
- Audit write cost on high-frequency paths (picklist turns) is unmeasured.
- No test verifies that every mutation path actually writes an entry.
