# 08 — Roles and Permissions

**The authorization model SchedulePoint ships.** Normative detail: SPEC-06 (truth table), doc 05, ADR-0004/0005, PO-DEC-02 (approved). Source evidence: report 02, glossary TERM-010..018.

---

## 1. What the evidence supports, and what it cannot

**Confirmed:** six source Access Levels exist (Staff, Locum, View, Telecom, Scheduler, Genius); **role is scoped per group membership, not per account** (multi-person corroboration — high confidence); eight independent permission flags vary independently of role; admin-surface access is gated by Access Level rather than the `Picklist Admin` flag (contradiction C-02).

**Not confirmable, permanently:** the actual capability set of any role other than Scheduler (no other session ever existed); whether Genius exceeds Scheduler at all. **Consequence, and the design's founding rule (PO-DEC-02):** SchedulePoint does not replicate a flag model it cannot test. *No permission flag ships without a tested capability difference.* Untestable distinctions (Genius-vs-Scheduler) are not shipped.

## 2. The four evaluation layers (approved)

```
1. Organization entitlement      — does the org have this module?        (PO-DEC-04)
2. Group/module availability     — is it enabled for this group?
3. Membership role               — does this person's role in THIS group allow it?
4. Explicit action capability    — named grant/deny for specific actions
```

Deny-by-default (I-02): a route/operation with no declared policy fails closed **and fails CI**. Precedence (SPEC-06): explicit deny beats every allow (P-1); no allow rescues an unentitled module or suspended membership (P-2); entitlement before permission (P-3). One pure evaluator decides every surface — HTTP, job, socket frame, report execution, download, export, support action (I-19). Freshness: four version counters bumped in the changing transaction + 30s hard TTL; sockets re-authorize per command frame; jobs re-authorize at execution and checkpoints; subscriptions closed on privilege change.

## 3. Shipped roles (per membership)

| Role | Maps from observed | Capability envelope (summary) |
|---|---|---|
| **Member — staff kind** | Staff | Own schedule, requests, vacation, marketplace participation, picklist turns, contacts, documents, profile |
| **Member — locum kind** | Locum | Member minus vacation entitlement by default; excluded from fairness credits by default; behind staff in the opportunity window (CAP-025). Kind, not a separate role — differences are scheduling rules, not permissions |
| **Viewer** | View | Read-only published schedules, contacts, documents |
| **Telecom** | Telecom | On-call board only (CAP-044) |
| **Scheduler** | Scheduler (+ Genius, merged) | Everything in [07](07-workflow-catalogue.md) §3: catalogue, rules, builds, publication, approvals, picklists, reports, messaging |
| **Group Admin** | (subset of observed admin surface) | Group settings, membership management, grants, documents admin, vocabulary/connector config |
| **Org Admin** | (no clean source equivalent) | Entitlements, group creation, identity administration (login-email change), org-wide audit |

Genius merges into Scheduler unless a real, testable capability difference is ever specified — in which case it becomes a named capability grant, not a role. A person may hold different roles in different groups (Confirmed source behaviour, preserved).

## 4. Named capability grants (layer 4)

Granular grants for actions whose blast radius exceeds their role's default: `schedule.publish`, `schedule.revert`, `vacation.commit`, `vacation.override_quota`, `picklist.administer`, `picklist.intervene`, `requests.batch_approve`, `identity.change_login_email`, `identity.impersonate`, `audit.export`, `entitlements.manage`, `messaging.bulk_send`, `documents.manage`, `connectors.manage`. Grant windows are effective-dated; **overlapping windows are prohibited by an exclusion constraint** so P-1 always has one unambiguous row. Every grant has an authorization test proving both allow and deny — the SPEC-06 generated cross-product runs against all six enforcement surfaces, which must agree.

## 5. Special access modes

- **Impersonation (CAP-010):** capability-gated, time-limited, banner-visible, barred from credential/MFA screens, every action double-attributed (actor + on-behalf-of), session-epoch bumped on start/end. The source has impersonation with no visible audit — ours is REDESIGN.
- **Proxy (CAP-034):** explicit grant records; default scope act-on-behalf for picklist turns (PO-DEC-19); actions attributed `acted_by` + `picked_by` distinctly (SPEC-02 selections carry both).
- **Support/break-glass:** separate privileged database roles outside the application role (SPEC-01 §4); privileged sessions are themselves audit-chained (SPEC-11).

## 6. Permission surface summary (role × area)

✓ = allowed by role · G = requires named grant · — = denied. (Authoritative: SPEC-06's generated table; this is the human-readable summary.)

| Area | Member | Viewer | Telecom | Scheduler | Group Admin | Org Admin |
|---|---|---|---|---|---|---|
| View published schedules | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| On-call board | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit requests/vacation | ✓ | — | — | ✓ | — | — |
| Marketplace participate | ✓ | — | — | ✓ | — | — |
| Picklist: take own turn / proxy | ✓ | — | — | ✓ | — | — |
| Approve requests/vacation | — | — | — | ✓ (batch: G) | — | — |
| Author catalogue & rules | — | — | — | ✓ | ✓ | — |
| Run builds / review quality | — | — | — | ✓ | — | — |
| Publish / revert versions | — | — | — | G | — | — |
| Vacation commit / quota override | — | — | — | G | — | — |
| Picklist administer/intervene | — | — | — | G | — | — |
| Reports & statistics | own | — | — | ✓ | ✓ | ✓ |
| Bulk messaging | — | — | — | G | G | — |
| Membership & grants | — | — | — | — | ✓ | ✓ |
| Group settings / vocabulary / connectors | — | — | — | — | ✓ (connectors: G) | ✓ |
| Entitlements | — | — | — | — | — | ✓ |
| Impersonation / login-email change | — | — | — | — | G | G |
| Audit query / export | — | — | — | own-actions | ✓ (export: G) | ✓ (export: G) |

## 7. Acceptance

The model is done when: SPEC-06's cross-product test passes on all six surfaces; every grant has a passing allow **and** deny test; SBX-001/002 (role fixtures, cross-group divergence — the same user holding different roles in two groups) pass; QA-TEN-003/012 and QA-AUTH-006/007/008 pass; and a CI check proves no route lacks a policy. Milestone: M1 foundation, extended as each module lands.
