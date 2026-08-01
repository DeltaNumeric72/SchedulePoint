# 18 — Capability Traceability

**Status: `PROPOSED`.**

> **REVISED 2026-08-01 (CAR-020, CAR-021, CAR-027).** Fourteen capability rows referenced **structures that did not exist** in the data catalogue, one referenced a column by the wrong name, and the architecture-blocker set listed **five** where [report 19](../../schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md) lists **seven**. Every mismatch is now resolved **explicitly** — either the structure was created, or the reference was corrected to the real name. **Nothing was renamed to make a mismatch disappear.** A semantic validator (`validate.py` checks 40–52) now fails the build on any unresolvable structure, ADR, capability, decision, invariant, or gate reference.

**Every one of the 58 capabilities in [report 19](../../schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md) appears below. There are no omissions, no summaries in place of entries, and no capability whose only architectural mapping is future work.**

Each entry records: disposition · milestone · gate · features · entities · state machines · architecture document · modules · primary data structures · interfaces and ports · background work · real-time involvement · authorization requirement · privacy and security consideration · testing strategy · ADRs · open questions and confidence.

> **Confidence describes the design, not evidence of behaviour.** No capability below has been implemented, and no test named below has been executed. A capability marked *High confidence* means the design rests on established practice and an approved decision — not that it works.

---

## 1. Coverage summary

| Metric | Value |
|---|---|
| Capabilities in the baseline | **58** |
| Capabilities mapped below | **58** |
| Mapped only to future work | **0** |
| Unmapped | **0** |

| Gate | Capabilities |
|---|---|
| `G-ARCH` | 5 |
| `G-BETA` | 15 |
| `G-CONN` | 4 |
| `G-PROD` | 34 |

| Milestone | Capabilities |
|---|---|
| foundation | 15 |
| alpha | 13 |
| beta | 24 |
| post-beta | 3 |
| continuous | 2 |
| post-production | 1 |

| Disposition | Capabilities |
|---|---|
| ADMINISTRATIVE FALLBACK OR OVERRIDE | 1 |
| EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION | 4 |
| REQUIRED FOR PRODUCTION | 47 |
| REQUIRED PLATFORM CAPABILITY AND NAMED CONNECTOR | 1 |
| REQUIRED PLATFORM CAPABILITY WITH CUSTOMER-SPECIFIC CONNECTOR | 1 |
| SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR | 4 |

> **No capability carries a disposition of excluded, abandoned, optional-because-difficult, indefinitely deferred, or post-MVP-without-a-gate.** Every capability has a production gate.

---

## 2. Capability entries

### CAP-001 · Organization tenancy root

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-ARCH` |
| **Features** | FEAT-002 |
| **Entities** | ENT-001 |
| **State machines** | — |
| **Architecture document** | [05](05-tenancy-entitlements-authorization.md) |
| **Modules** | M-02 |
| **Primary data structures** | organizations, organization_settings *(created — CAR-020)* |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | Org context resolved server-side from membership; never from a client parameter |
| **Privacy / security consideration** | Tenant root; every tenant table carries organization_id |
| **Testing strategy** | QA: QA-TEN-001, QA-TEN-005, QA-TEN-006 · Sandbox: SBX-004 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-002 · Group scheduling scope and switching

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-ARCH` |
| **Features** | FEAT-001 |
| **Entities** | ENT-002, ENT-006 |
| **State machines** | — |
| **Architecture document** | [05](05-tenancy-entitlements-authorization.md) |
| **Modules** | M-02, M-03 |
| **Primary data structures** | groups, memberships, group_settings |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | Group switching re-resolves capabilities from the target membership; a stale capability set is never reused |
| **Privacy / security consideration** | Cross-group read is denied by default |
| **Testing strategy** | QA: QA-TEN-002 · Sandbox: SBX-001, SBX-004 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) · [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-003 · Server- and database-enforced tenant isolation

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-PROD` |
| **Features** | FEAT-003 |
| **Entities** | ENT-001, ENT-002, ENT-006 |
| **State machines** | — |
| **Architecture document** | [05](05-tenancy-entitlements-authorization.md) · [06](06-data-architecture.md) · [14](14-security-and-privacy.md) |
| **Modules** | M-02, M-03 + every module |
| **Primary data structures** | All tenant tables; RLS policies |
| **Interfaces / ports** | Tenant context resolver |
| **Background / async work** | — |
| **Real-time involvement** | **Tenant context declared and verified on every command frame** *(amended 2026-08-01, V-20 — the previous "resolved once at connection establishment" model is withdrawn; [SPEC-01](specs/SPEC-01-request-context-and-tenant-isolation.md) §5, [rationale](remediation/internal-verification-corrections.md) §2)* |
| **Authorization requirement** | **Deny-by-default at route, object, and row level** |
| **Privacy / security consideration** | T-01, T-03: RLS with FORCE as defence in depth; composite FKs prevent cross-tenant references |
| **Testing strategy** | QA: QA-SEC-008, QA-TEN-005 · Sandbox: SBX-004 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) · [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **Open questions / confidence** | RLS performance under load is unmeasured (A-6). Confidence: High on design, Medium on cost |

### CAP-004 · Site (physical location) modelling

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-004 |
| **Entities** | ENT-003 |
| **State machines** | — |
| **Architecture document** | [06](06-data-architecture.md) · [07](07-schedule-and-publication.md) |
| **Modules** | M-02, M-06 |
| **Primary data structures** | locations.site_label *(attribute — PO-DEC-01 pending default; `sites`, `group_sites`, and `shift_type_sites` are withdrawn, not materialised — CAR-021)* |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | Site visibility follows group scope |
| **Privacy / security consideration** | Site names are operational, not personal |
| **Testing strategy** | QA: — · Sandbox: SBX-019 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) |
| **Open questions / confidence** | Whether sites nest is UNRESOLVED in the source; SchedulePoint models a flat list with explicit group association. Confidence: Medium |

### CAP-005 · User accounts and account types

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-BETA` |
| **Features** | FEAT-005 |
| **Entities** | ENT-004, ENT-005 |
| **State machines** | STM-017, STM-018 |
| **Architecture document** | [05](05-tenancy-entitlements-authorization.md) · [14](14-security-and-privacy.md) |
| **Modules** | M-01 |
| **Primary data structures** | users *(`login_email`, administrator/IdP-changeable — CAR-027)*, user_identities *(created — CAR-020)* |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | Account-type differences are enforced server-side, not by UI hiding |
| **Privacy / security consideration** | Service and placeholder accounts must never receive notifications intended for people |
| **Testing strategy** | QA: QA-AUTH-005, QA-AUTH-011, QA-SEC-014 · Sandbox: SBX-005 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **Open questions / confidence** | PO-DEC-06 (one user across multiple organizations — recommended *no* for the first release) pending. Confidence: High |

### CAP-006 · Membership-scoped roles and capabilities

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-ARCH` |
| **Features** | FEAT-006 |
| **Entities** | ENT-006, ENT-007, ENT-008 |
| **State machines** | — |
| **Architecture document** | [05](05-tenancy-entitlements-authorization.md) |
| **Modules** | M-03 |
| **Primary data structures** | memberships, membership_roles, role_capabilities, capability_grants |
| **Interfaces / ports** | Capability resolver |
| **Background / async work** | — |
| **Real-time involvement** | **Capability set re-evaluated on every command frame, and on every push for sensitive topics** *(amended 2026-08-01, V-20 — a capability set fixed at connection establishment leaves a revoked capability effective for the life of the socket, the CAR-008 defect; [SPEC-06](specs/SPEC-06-authorization-truth-table.md) §6 and §6.1)* |
| **Authorization requirement** | **The model itself.** organization entitlement → module availability → membership role → explicit capability |
| **Privacy / security consideration** | A capability change is audited in both directions |
| **Testing strategy** | QA: QA-AUTH-006, QA-TEN-003 · Sandbox: SBX-001, SBX-002 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **Open questions / confidence** | PO-DEC-02 **APPROVED**. No further decision outstanding. Confidence: High |

### CAP-007 · Self-service profile, credentials, and preferences

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-PROD` |
| **Features** | FEAT-007 |
| **Entities** | ENT-004, ENT-005, ENT-009 |
| **State machines** | — |
| **Architecture document** | [05](05-tenancy-entitlements-authorization.md) · [14](14-security-and-privacy.md) |
| **Modules** | M-01, M-18 |
| **Primary data structures** | users, notification_preferences, contact_methods |
| **Interfaces / ports** | — |
| **Background / async work** | Contact verification jobs |
| **Real-time involvement** | No |
| **Authorization requirement** | A user edits only their own profile unless holding an administrative capability |
| **Privacy / security consideration** | Contact values are PII; stored minimally, hashed where used as a suppression key |
| **Testing strategy** | QA: QA-AUTH-004, QA-SEC-011, QA-SEC-014 · Sandbox: SBX-005 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-008 · Authentication and session management

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-BETA` |
| **Features** | FEAT-008 |
| **Entities** | ENT-004 |
| **State machines** | STM-017 |
| **Architecture document** | [14](14-security-and-privacy.md) |
| **Modules** | M-01 |
| **Primary data structures** | sessions, credentials, mfa_enrolments |
| **Interfaces / ports** | Auth provider port (for future OIDC) |
| **Background / async work** | Session sweeping |
| **Real-time involvement** | Connection authenticated from the session |
| **Authorization requirement** | Pre-authentication routes are explicitly declared |
| **Privacy / security consideration** | T-07, T-22: rotation, bounded lifetimes, MFA, lockout |
| **Testing strategy** | QA: QA-AUTH-001, QA-AUTH-012, QA-AUTH-013 · Sandbox: SBX-005, SBX-006 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **Open questions / confidence** | PO-DEC-09 (MFA/SSO scope) pending. Confidence: High |

### CAP-009 · Invitation and activation, separated from password reset

| Field | Value |
|---|---|
| **Disposition** | SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR |
| **Milestone** | foundation |
| **Gate** | `G-BETA` |
| **Features** | FEAT-005, FEAT-008 |
| **Entities** | ENT-004, ENT-006 |
| **State machines** | STM-017 |
| **Architecture document** | [14](14-security-and-privacy.md) |
| **Modules** | M-01 |
| **Primary data structures** | invitations |
| **Interfaces / ports** | Email port |
| **Background / async work** | Invitation expiry sweep |
| **Real-time involvement** | No |
| **Authorization requirement** | Invitation issuance requires an administrative capability |
| **Privacy / security consideration** | **Single-use, expiring, revocable, and separate from password reset** — the source conflated them |
| **Testing strategy** | QA: QA-AUTH-004 · Sandbox: SBX-005 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-010 · Administrative impersonation

| Field | Value |
|---|---|
| **Disposition** | SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR |
| **Milestone** | beta |
| **Gate** | `G-BETA` |
| **Features** | FEAT-009 |
| **Entities** | ENT-004, ENT-040 |
| **State machines** | — |
| **Architecture document** | [05](05-tenancy-entitlements-authorization.md) · [14](14-security-and-privacy.md) · [15](15-audit-and-observability.md) |
| **Modules** | M-01, M-24 |
| **Primary data structures** | impersonation_sessions, audit_events |
| **Interfaces / ports** | — |
| **Background / async work** | Session expiry |
| **Real-time involvement** | Impersonation banner state |
| **Authorization requirement** | **A distinct capability, never implied by an administrative role** |
| **Privacy / security consideration** | T-06: time-limited, banner-visible, credential screens barred, every action records on_behalf_of |
| **Testing strategy** | QA: QA-AUTH-010 · Sandbox: SBX-005 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) · [ADR-0013](decisions/ADR-0013-audit-architecture.md) |
| **Open questions / confidence** | PO-DEC-11 (impersonation scope — recommended audited, banner, time-limited, no credential screens) pending. Confidence: High |

### CAP-057 · Entitlement and feature gating

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-ARCH` |
| **Features** | FEAT-057 |
| **Entities** | ENT-041 |
| **State machines** | STM-024 |
| **Architecture document** | [05](05-tenancy-entitlements-authorization.md) |
| **Modules** | M-04 |
| **Primary data structures** | entitlements, entitlement_modules, module_dependencies |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | **Entitlement re-checked on every command frame for live features**, and affected subscriptions closed immediately on entitlement loss *(amended 2026-08-01, V-20 — [SPEC-06](specs/SPEC-06-authorization-truth-table.md) §2 L1 and §6)* |
| **Authorization requirement** | **Entitlement is checked before permission — an entitled-off module is unavailable regardless of role** |
| **Privacy / security consideration** | Disabling never deletes data (PO-DEC-04) |
| **Testing strategy** | QA: QA-AUTH-007, QA-TEN-005 · Sandbox: SBX-002 |
| **ADRs** | [ADR-0005](decisions/ADR-0005-entitlement-architecture.md) |
| **Open questions / confidence** | PO-DEC-04 **APPROVED — technical architecture only. Commercial packaging remains pending.** Confidence: High |

### CAP-011 · Shift type catalogue

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-PROD` |
| **Features** | FEAT-010 |
| **Entities** | ENT-011 |
| **State machines** | — |
| **Architecture document** | [06](06-data-architecture.md) · [07](07-schedule-and-publication.md) |
| **Modules** | M-06 |
| **Primary data structures** | shift_types, shift_type_qualifications *(`shift_type_sites` never existed and is withdrawn with the Site entity — CAR-020/CAR-021)* |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | Configuration change requires a scheduling-configuration capability |
| **Privacy / security consideration** | — |
| **Testing strategy** | QA: QA-SCH-004, QA-SCH-006, QA-SCH-013 · Sandbox: SBX-015 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-012 · Shift groups and staff groups

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-PROD` |
| **Features** | FEAT-013, FEAT-014 |
| **Entities** | ENT-012, ENT-013 |
| **State machines** | — |
| **Architecture document** | [06](06-data-architecture.md) · [07](07-schedule-and-publication.md) |
| **Modules** | M-06 |
| **Primary data structures** | shift_groups, staff_groups, shift_group_members, staff_group_members |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | As above |
| **Privacy / security consideration** | — |
| **Testing strategy** | QA: QA-REQ-003, QA-SCH-006 · Sandbox: SBX-010 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) |
| **Open questions / confidence** | Source semantics of the two grouping concepts are partly INFERRED; SchedulePoint separates them explicitly. Confidence: Medium-High |

### CAP-013 · Weekday-variable FTE, maximum assignments, work percentage

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-013 |
| **Entities** | ENT-006, ENT-011 |
| **State machines** | — |
| **Architecture document** | [06](06-data-architecture.md) · [08](08-automated-scheduling-engine.md) |
| **Modules** | M-06 |
| **Primary data structures** | membership_work_profiles + membership_weekday_fte *(both created — CAR-006/CAR-020; previously referenced and undefined)* |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | Editing another member's work profile requires an administrative capability |
| **Privacy / security consideration** | Work percentage is employment data — minimised in directory views |
| **Testing strategy** | QA: QA-SCH-006 · Sandbox: SBX-015, SBX-031 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) · [ADR-0006](decisions/ADR-0006-solver-architecture.md) |
| **Open questions / confidence** | Exact source normalisation formula is UNRESOLVED; SchedulePoint defines its own and documents it. Confidence: Medium |

### CAP-058 · Qualifications, credentials, expiry, and eligibility

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-058 |
| **Entities** | ENT-011, ENT-042, ENT-043 |
| **State machines** | STM-022 |
| **Architecture document** | [06](06-data-architecture.md) · [08](08-automated-scheduling-engine.md) · [09](09-requests-vacation-opportunities-transfers.md) |
| **Modules** | M-05 |
| **Primary data structures** | qualifications, membership_qualifications (valid_from, valid_to, revoked_at) |
| **Interfaces / ports** | — |
| **Background / async work** | Expiry-warning job |
| **Real-time involvement** | No |
| **Authorization requirement** | Granting or revoking a qualification requires an administrative capability |
| **Privacy / security consideration** | Credential data is sensitive employment data |
| **Testing strategy** | QA: QA-SCH-006 · Sandbox: SBX-019 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) · [ADR-0006](decisions/ADR-0006-solver-architecture.md) |
| **Open questions / confidence** | **Eligibility must be evaluated at the shift date, not at request time** — a fixture exists for this. PO-DEC-12 (qualification ownership) pending. Confidence: High |

### CAP-014 · Schedule periods and versioned publication

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-015, FEAT-018, FEAT-019 |
| **Entities** | ENT-015, ENT-016 |
| **State machines** | STM-003, STM-004 |
| **Architecture document** | [07](07-schedule-and-publication.md) |
| **Modules** | M-12, M-09 |
| **Primary data structures** | schedule_periods, schedule_versions, assignment_identities, assignment_snapshots |
| **Interfaces / ports** | — |
| **Background / async work** | Publication notification fan-out via outbox |
| **Real-time involvement** | Publication events push to viewers |
| **Authorization requirement** | Publishing requires an explicit publish capability distinct from editing |
| **Privacy / security consideration** | Version history is immutable; supersession never deletes |
| **Testing strategy** | QA: QA-CON-010, QA-SCH-001 · Sandbox: SBX-018 |
| **ADRs** | [ADR-0007](decisions/ADR-0007-schedule-versioning.md) |
| **Open questions / confidence** | None outstanding; amendment granularity is defined in [07](07-schedule-and-publication.md) §4. Confidence: High |

### CAP-015 · Automated schedule generation

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-016 |
| **Entities** | ENT-023b, ENT-024, ENT-025b |
| **State machines** | STM-001 |
| **Architecture document** | [08](08-automated-scheduling-engine.md) |
| **Modules** | M-10 |
| **Primary data structures** | schedule_builds, build_inputs, build_results |
| **Interfaces / ports** | **SolverPort** |
| **Background / async work** | **Scheduling worker** — long-running |
| **Real-time involvement** | Build progress pushed to the initiating scheduler |
| **Authorization requirement** | Building requires a schedule-generation capability |
| **Privacy / security consideration** | Solver inputs contain no patient data; models are never logged in full |
| **Testing strategy** | QA: QA-CON-002, QA-SCH-001 · Sandbox: SBX-015, SBX-031 |
| **ADRs** | [ADR-0006](decisions/ADR-0006-solver-architecture.md) |
| **Open questions / confidence** | **The source's algorithm is not known and is not reproduced.** SchedulePoint states its own model. PO-DEC-23 (solver performance targets) pending. Confidence: Medium — solver behaviour is unproven until benchmarked |

### CAP-016 · Rule engine: patterns, staff rules, position restrictions, templates

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-017 |
| **Entities** | ENT-021, ENT-022, ENT-023, ENT-023b, ENT-048 |
| **State machines** | — |
| **Architecture document** | [08](08-automated-scheduling-engine.md) |
| **Modules** | M-06, M-10 |
| **Primary data structures** | rules *(typed versioned AST — created, CAR-006)*, rule_sets, pattern_rules, valid_groups, assignment_templates |
| **Interfaces / ports** | SolverPort constraint translation |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | Rule editing requires a configuration capability |
| **Privacy / security consideration** | — |
| **Testing strategy** | QA: QA-SCH-005, QA-SCH-006 · Sandbox: SBX-015, SBX-016 |
| **ADRs** | [ADR-0006](decisions/ADR-0006-solver-architecture.md) |
| **Open questions / confidence** | Source rule semantics are partly INFERRED. SchedulePoint defines each constraint explicitly. PO-DEC-05 (rule authoring: self-service vs. vendor) pending. Confidence: Medium-High |

### CAP-017 · Progressive builds around fixed assignments

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-016 |
| **Entities** | ENT-024 |
| **State machines** | STM-001, STM-002 |
| **Architecture document** | [08](08-automated-scheduling-engine.md) |
| **Modules** | M-10, M-11 |
| **Primary data structures** | assignment_snapshots (**`is_pinned`** — the trace said `is_fixed`, the schema said `is_locked`; both are retired — CAR-020), solver_inputs |
| **Interfaces / ports** | SolverPort (fixed-assignment constraints) |
| **Background / async work** | Scheduling worker |
| **Real-time involvement** | Progress push |
| **Authorization requirement** | Build capability |
| **Privacy / security consideration** | — |
| **Testing strategy** | QA: QA-SCH-002 · Sandbox: SBX-017 |
| **ADRs** | [ADR-0006](decisions/ADR-0006-solver-architecture.md) · [ADR-0007](decisions/ADR-0007-schedule-versioning.md) |
| **Open questions / confidence** | None beyond CAP-015. Confidence: Medium-High |

### CAP-018 · Partial-schedule circulation

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-016 |
| **Entities** | ENT-016 |
| **State machines** | STM-002 |
| **Architecture document** | [07](07-schedule-and-publication.md) |
| **Modules** | M-12 |
| **Primary data structures** | schedule_versions (circulation state) |
| **Interfaces / ports** | — |
| **Background / async work** | Circulation notification fan-out |
| **Real-time involvement** | Circulation state visible |
| **Authorization requirement** | Circulating a partial schedule requires the publish capability family |
| **Privacy / security consideration** | **A circulated partial schedule must be visibly distinguishable from a published one** |
| **Testing strategy** | QA: QA-SCH-001 · Sandbox: SBX-017 |
| **ADRs** | [ADR-0007](decisions/ADR-0007-schedule-versioning.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-059 · Conflict detection and build-quality verification

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-059 |
| **Entities** | ENT-025b, ENT-026b |
| **State machines** | STM-002 |
| **Architecture document** | [07](07-schedule-and-publication.md) · [08](08-automated-scheduling-engine.md) |
| **Modules** | M-10, M-11 |
| **Primary data structures** | schedule_conflicts (ENT-049), build_results.quality |
| **Interfaces / ports** | SolverPort result interpretation |
| **Background / async work** | Conflict re-evaluation on change |
| **Real-time involvement** | Conflicts pushed on publication |
| **Authorization requirement** | Conflict visibility follows schedule visibility |
| **Privacy / security consideration** | — |
| **Testing strategy** | QA: QA-SCH-002, QA-SCH-005 · Sandbox: SBX-016 |
| **ADRs** | [ADR-0006](decisions/ADR-0006-solver-architecture.md) · [ADR-0007](decisions/ADR-0007-schedule-versioning.md) |
| **Open questions / confidence** | PO-DEC-13 (conflict-severity taxonomy) pending. Quality metrics require benchmarking before thresholds can be set. Confidence: Medium |

### CAP-019 · Manual scheduling, override, and fixed assignments

| Field | Value |
|---|---|
| **Disposition** | ADMINISTRATIVE FALLBACK OR OVERRIDE |
| **Milestone** | foundation |
| **Gate** | `G-BETA` |
| **Features** | FEAT-012, FEAT-027 |
| **Entities** | ENT-014, ENT-017 |
| **State machines** | STM-004 |
| **Architecture document** | [07](07-schedule-and-publication.md) |
| **Modules** | M-11 |
| **Primary data structures** | assignment_identities + assignment_snapshots *(replaces `assignments`)*; change history is snapshots joined by identity plus audit_events *(`assignment_audit` never existed — CAR-020)* |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | Grid updates push where a live view is open |
| **Authorization requirement** | Manual override requires an explicit capability and records a reason |
| **Privacy / security consideration** | **Every manual override is audited with actor and reason** — the observed product's silent edits are not reproduced |
| **Testing strategy** | QA: QA-CON-001, QA-SCH-008 · Sandbox: SBX-017, SBX-018 |
| **ADRs** | [ADR-0007](decisions/ADR-0007-schedule-versioning.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-020 · Schedule viewing, three views, and daily assignment sheet

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-011, FEAT-033 |
| **Entities** | ENT-014 |
| **State machines** | — |
| **Architecture document** | [07](07-schedule-and-publication.md) · [13](13-reports-calendars-and-documents.md) |
| **Modules** | M-11, M-12, M-21 |
| **Primary data structures** | assignment_snapshots, schedule_versions; read models |
| **Interfaces / ports** | — |
| **Background / async work** | Report/print generation |
| **Real-time involvement** | Published-version changes push |
| **Authorization requirement** | Read scope follows membership; cross-group views require an explicit capability |
| **Privacy / security consideration** | Daily assignment sheets carry no clinical content |
| **Testing strategy** | QA: QA-A11Y-006, QA-SCH-010 · Sandbox: SBX-033, SBX-034 |
| **ADRs** | [ADR-0007](decisions/ADR-0007-schedule-versioning.md) · [ADR-0014](decisions/ADR-0014-file-and-report-storage.md) |
| **Open questions / confidence** | Confidence: High |

### CAP-021 · Requests: ON, OFF, No Call, shift preference

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-BETA` |
| **Features** | FEAT-020 |
| **Entities** | ENT-018, ENT-025 |
| **State machines** | STM-005, STM-006 |
| **Architecture document** | [09](09-requests-vacation-opportunities-transfers.md) |
| **Modules** | M-13 |
| **Primary data structures** | requests *(aggregate root)* + five constrained subtype tables; decisions are recorded in `approvals` *(`request_decisions` never existed — CAR-020)* |
| **Interfaces / ports** | — |
| **Background / async work** | Decision notifications |
| **Real-time involvement** | No |
| **Authorization requirement** | Submitting is self-scoped; deciding requires an approval capability |
| **Privacy / security consideration** | Request reasons may be personal — minimised in reports |
| **Testing strategy** | QA: QA-REQ-001, QA-REQ-013 · Sandbox: SBX-010, SBX-011 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) |
| **Open questions / confidence** | PO-DEC-03 (canonical request model) confirmatory. Confidence: High |

### CAP-022 · Vacation: quota/grant mode and open mode

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-BETA` |
| **Features** | FEAT-021 |
| **Entities** | ENT-019, ENT-020, ENT-021b |
| **State machines** | STM-007 |
| **Architecture document** | [09](09-requests-vacation-opportunities-transfers.md) |
| **Modules** | M-14 |
| **Primary data structures** | vacation_selections, vacation_grants *(the two `kind` values are `personal-entitlement` and `weekly-capacity`; `vacation_entitlements`/`vacation_capacity` were never separate tables — CAR-020)* |
| **Interfaces / ports** | — |
| **Background / async work** | Quota recalculation |
| **Real-time involvement** | No |
| **Authorization requirement** | Selecting is self-scoped; approving requires a capability |
| **Privacy / security consideration** | **Over-quota is advisory, not blocking** — a deliberate preserved behaviour |
| **Testing strategy** | QA: QA-REQ-002, QA-REQ-007 · Sandbox: SBX-012, SBX-013 |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) |
| **Open questions / confidence** | PO-DEC-14 (default mode) pending. Confidence: High |

### CAP-023 · Vacation commit to schedule

| Field | Value |
|---|---|
| **Disposition** | SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR |
| **Milestone** | alpha |
| **Gate** | `G-BETA` |
| **Features** | FEAT-022 |
| **Entities** | ENT-016, ENT-019 |
| **State machines** | STM-007 |
| **Architecture document** | [09](09-requests-vacation-opportunities-transfers.md) |
| **Modules** | M-14, M-12 |
| **Primary data structures** | vacation_selections.committed_to_version_id, assignment_snapshots |
| **Interfaces / ports** | — |
| **Background / async work** | Commit job for large ranges |
| **Real-time involvement** | Publication push |
| **Authorization requirement** | Committing requires the vacation-approval capability |
| **Privacy / security consideration** | **Idempotent and reversible via versioning** — replacing the source's irreversible one-way transfer |
| **Testing strategy** | QA: QA-CON-003, QA-CON-010, QA-REQ-010 · Sandbox: SBX-012 |
| **ADRs** | [ADR-0007](decisions/ADR-0007-schedule-versioning.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-024 · Opportunity board with email fan-out

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-BETA` |
| **Features** | FEAT-025 |
| **Entities** | ENT-026 |
| **State machines** | STM-008 |
| **Architecture document** | [09](09-requests-vacation-opportunities-transfers.md) |
| **Modules** | M-15 |
| **Primary data structures** | opportunities |
| **Interfaces / ports** | — |
| **Background / async work** | Fan-out via outbox |
| **Real-time involvement** | Optional live board update |
| **Authorization requirement** | Posting is self-scoped to one's own assignment; claiming requires eligibility |
| **Privacy / security consideration** | Recipients resolve **only from the roster** |
| **Testing strategy** | QA: QA-OPP-001 · Sandbox: SBX-013b, SBX-014b |
| **ADRs** | [ADR-0009](decisions/ADR-0009-job-and-event-reliability.md) · [ADR-0010](decisions/ADR-0010-notification-architecture.md) |
| **Open questions / confidence** | PO-DEC-15 (recipient filtering) pending. Confidence: High |

### CAP-025 · Staff preference over locums for extra work

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-025 |
| **Entities** | ENT-006, ENT-026 |
| **State machines** | STM-008 |
| **Architecture document** | [09](09-requests-vacation-opportunities-transfers.md) |
| **Modules** | M-15 |
| **Primary data structures** | opportunities.locum_priority_until, memberships.is_locum |
| **Interfaces / ports** | — |
| **Background / async work** | Window-expiry job |
| **Real-time involvement** | Board update |
| **Authorization requirement** | Locum claim denied during the window |
| **Privacy / security consideration** | — |
| **Testing strategy** | QA: QA-OPP-002, QA-OPP-003 · Sandbox: SBX-013b |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) |
| **Open questions / confidence** | PO-DEC-16 (default window) pending. Confidence: Medium-High |

### CAP-026 · Shift offers, swaps, and transfers with optional review

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-BETA` |
| **Features** | FEAT-026, FEAT-027 |
| **Entities** | ENT-027, ENT-028 |
| **State machines** | STM-009, STM-010, STM-011 |
| **Architecture document** | [09](09-requests-vacation-opportunities-transfers.md) |
| **Modules** | M-16 |
| **Primary data structures** | shift_offers, shift_swaps, transfers *(all binding `assignment_identity_id` + `source_version_id` — CAR-018)* |
| **Interfaces / ports** | — |
| **Background / async work** | Notification fan-out |
| **Real-time involvement** | Optional |
| **Authorization requirement** | Counterpart acceptance always required; scheduler review is per-group policy |
| **Privacy / security consideration** | **Both legs commit or neither** — a half-executed swap is the worst outcome |
| **Testing strategy** | QA: QA-OPP-009 · Sandbox: SBX-014c |
| **ADRs** | [ADR-0007](decisions/ADR-0007-schedule-versioning.md) |
| **Open questions / confidence** | PO-DEC-17 (default review policy) pending. Confidence: High |

### CAP-027 · Schedule-change audit and affected-staff notification

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-PROD` |
| **Features** | FEAT-045 |
| **Entities** | ENT-040 |
| **State machines** | — |
| **Architecture document** | [15](15-audit-and-observability.md) |
| **Modules** | M-24 |
| **Primary data structures** | audit_events |
| **Interfaces / ports** | — |
| **Background / async work** | Affected-staff notification fan-out |
| **Real-time involvement** | No |
| **Authorization requirement** | Audit read requires an explicit capability; **audit is never mutable by anyone** |
| **Privacy / security consideration** | **No patient data, no clinical free text, no credentials in any audit payload** |
| **Testing strategy** | QA: QA-AUTH-009, QA-CON-011, QA-SCH-015 · Sandbox: SBX-018, SBX-030a |
| **ADRs** | [ADR-0013](decisions/ADR-0013-audit-architecture.md) |
| **Open questions / confidence** | None. Confidence: High |

### CAP-030 · Picklist preparation

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-030 |
| **Entities** | ENT-029, ENT-030, ENT-031 |
| **State machines** | STM-012 |
| **Architecture document** | [10](10-picklist-and-realtime.md) |
| **Modules** | M-17 |
| **Primary data structures** | picklists, picklist_work_items *(no free text — CAR-004)*, picklist_participants, work_item_labels |
| **Interfaces / ports** | — |
| **Background / async work** | Participant sync from published schedule |
| **Real-time involvement** | Draft state is not live |
| **Authorization requirement** | Preparation requires a picklist-administration capability |
| **Privacy / security consideration** | **No Add/New/Create control persists before an explicit Save** (I-13 — renumbered from the colliding `I-05`, CAR-023) |
| **Testing strategy** | QA: QA-PICK-001, QA-PICK-015 · Sandbox: SBX-020 |
| **ADRs** | [ADR-0008](decisions/ADR-0008-realtime-picklist-transport.md) |
| **Open questions / confidence** | Source preparation flow was never observed. Confidence: Medium |

### CAP-060 · Picklist operating modes: paper, manual-entry, integrated

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-060 |
| **Entities** | ENT-029 |
| **State machines** | STM-012 |
| **Architecture document** | [10](10-picklist-and-realtime.md) · [12](12-integrations-and-ingestion-privacy.md) |
| **Modules** | M-17, M-07 |
| **Primary data structures** | picklists.mode |
| **Interfaces / ports** | Connector interface (integrated mode) |
| **Background / async work** | Import batches |
| **Real-time involvement** | Mode is a precondition of ready |
| **Authorization requirement** | Integrated mode requires the hospital_integration entitlement |
| **Privacy / security consideration** | Imported items pass the ingestion boundary |
| **Testing strategy** | QA: QA-PICK-001 · Sandbox: SBX-020 |
| **ADRs** | [ADR-0008](decisions/ADR-0008-realtime-picklist-transport.md) · [ADR-0012](decisions/ADR-0012-connector-architecture.md) |
| **Open questions / confidence** | Confidence: Medium-High |

### CAP-031 · Picklist execution

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-031, FEAT-032 |
| **Entities** | ENT-029, ENT-030, ENT-032 |
| **State machines** | STM-013, STM-014 |
| **Architecture document** | [10](10-picklist-and-realtime.md) |
| **Modules** | M-17 |
| **Primary data structures** | picklist_turns, selections, picklist_commands, picklist_events |
| **Interfaces / ports** | — |
| **Background / async work** | Turn-expiry sweeper |
| **Real-time involvement** | **Yes — the primary real-time surface** |
| **Authorization requirement** | Selecting requires being the current picker or their authorized proxy |
| **Privacy / security consideration** | No patient data in work items |
| **Testing strategy** | QA: QA-A11Y-014, QA-PICK-005 · Sandbox: SBX-021, SBX-024, SBX-027 |
| **ADRs** | [ADR-0008](decisions/ADR-0008-realtime-picklist-transport.md) |
| **Open questions / confidence** | **Execution was never observed across thirteen research phases.** Confidence: Medium — design is sound, behaviour is unverified |

### CAP-032 · Picklist concurrency and real-time state

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-032, FEAT-035 |
| **Entities** | — |
| **State machines** | STM-013, STM-014 |
| **Architecture document** | [10](10-picklist-and-realtime.md) |
| **Modules** | M-17 + real-time coordinator |
| **Primary data structures** | selections *(**three** partial unique indexes: D-3a one result per turn, D-3b one claimant per item, D-3c one open turn — CAR-003)*, picklist_events, picklist_commands, picklist_leases, picklists.aggregate_version |
| **Interfaces / ports** | Real-time transport port |
| **Background / async work** | Coordinator process |
| **Real-time involvement** | **Yes — server-authoritative** |
| **Authorization requirement** | Subscription authorized per topic **and re-evaluated on every push** ([SPEC-06](specs/SPEC-06-authorization-truth-table.md) §6.1, batched one evaluation per recipient per event, fail-closed per recipient); **tenant declared and verified per command frame** *(amended 2026-08-01, V-20)* |
| **Privacy / security consideration** | T-08: a subscribe outside the **frame's declared** tenant is denied and logged *(amended 2026-08-01, V-20)* |
| **Testing strategy** | QA: QA-CON-004, QA-PICK-005 · Sandbox: SBX-022, SBX-023 |
| **ADRs** | [ADR-0008](decisions/ADR-0008-realtime-picklist-transport.md) |
| **Open questions / confidence** | PO-DEC-18 APPROVED. **SBX-022 (≥50 trials) is the evidence that matters.** Confidence: Medium-High |

### CAP-033 · Administrator picklist intervention and monitoring

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-032, FEAT-035 |
| **Entities** | — |
| **State machines** | STM-013 |
| **Architecture document** | [10](10-picklist-and-realtime.md) |
| **Modules** | M-17 |
| **Primary data structures** | picklist_turns, audit_events |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | Yes |
| **Authorization requirement** | Intervention requires an administrative capability |
| **Privacy / security consideration** | **Always attributed to the administrator, never silently to the staff member** |
| **Testing strategy** | QA: QA-PICK-008, QA-PICK-013 · Sandbox: SBX-025 |
| **ADRs** | [ADR-0008](decisions/ADR-0008-realtime-picklist-transport.md) · [ADR-0013](decisions/ADR-0013-audit-architecture.md) |
| **Open questions / confidence** | Confidence: Medium-High |

### CAP-034 · Proxy delegation

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-BETA` |
| **Features** | FEAT-034 |
| **Entities** | ENT-010 |
| **State machines** | STM-019 |
| **Architecture document** | [10](10-picklist-and-realtime.md) |
| **Modules** | M-03, M-17 |
| **Primary data structures** | proxy_grants *(renamed from `proxies` — CAR-020)* |
| **Interfaces / ports** | — |
| **Background / async work** | Grant expiry |
| **Real-time involvement** | Proxy identity shown in live state |
| **Authorization requirement** | **An explicit grant, never implied by a role** |
| **Privacy / security consideration** | Both proxy and grantor named on every action |
| **Testing strategy** | QA: QA-AUTH-008 · Sandbox: SBX-026 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) · [ADR-0013](decisions/ADR-0013-audit-architecture.md) |
| **Open questions / confidence** | PO-DEC-19 (default proxy scope) pending. Confidence: Medium-High |

### CAP-040 · Notification delivery, escalation, retry, and deduplication

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-040 |
| **Entities** | ENT-034, ENT-035, ENT-035b |
| **State machines** | STM-015, STM-016 |
| **Architecture document** | [11](11-notifications-and-communications.md) |
| **Modules** | M-19 |
| **Primary data structures** | notification_intents *(created)*, logical_deliveries *(created)*, notification_messages, delivery_attempts, provider_callbacks *(created)*, escalation_policies |
| **Interfaces / ports** | Provider ports |
| **Background / async work** | **Outbox relay + dispatch workers** |
| **Real-time involvement** | No |
| **Authorization requirement** | Delivery is system-initiated; policy editing requires a capability |
| **Privacy / security consideration** | No clinical content in message bodies; no PII in URLs |
| **Testing strategy** | QA: QA-CON-009, QA-NOT-001 · Sandbox: SBX-030a |
| **ADRs** | [ADR-0009](decisions/ADR-0009-job-and-event-reliability.md) · [ADR-0010](decisions/ADR-0010-notification-architecture.md) |
| **Open questions / confidence** | None outstanding; escalation defaults are group configuration, not a product decision. Confidence: High |

### CAP-041 · Notification channels: email, SMS, voice, push

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-040, FEAT-061 |
| **Entities** | ENT-047 |
| **State machines** | STM-025 |
| **Architecture document** | [11](11-notifications-and-communications.md) |
| **Modules** | M-19 |
| **Primary data structures** | logical_deliveries.channel, push_registrations *(`push_tokens` never existed — CAR-020)* |
| **Interfaces / ports** | Email/SMS/voice/push ports |
| **Background / async work** | Dispatch workers |
| **Real-time involvement** | No |
| **Authorization requirement** | — |
| **Privacy / security consideration** | Push requires explicit consent; tokens hashed and cleaned up when invalid |
| **Testing strategy** | QA: QA-NOT-005, QA-NOT-011 · Sandbox: SBX-030a, SBX-030b |
| **ADRs** | [ADR-0010](decisions/ADR-0010-notification-architecture.md) |
| **Open questions / confidence** | C-10: push is publicly claimed but absent from the source application. **No removal is asserted.** PO-DEC-07 confirmatory. Confidence: Medium-High |

### CAP-042 · Contacts directory with minimised PII

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-BETA` |
| **Features** | FEAT-041 |
| **Entities** | ENT-004, ENT-005 |
| **State machines** | — |
| **Architecture document** | [11](11-notifications-and-communications.md) |
| **Modules** | M-20 |
| **Primary data structures** | directory read model |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | **Directory inclusion is an explicit policy, not an emergent filter** |
| **Privacy / security consideration** | **Field-level minimisation server-side — the API never returns what the UI hides** |
| **Testing strategy** | QA: QA-SEC-014 · Sandbox: SBX-003 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **Open questions / confidence** | C-06: the source's ~30–35% directory filter remains UNRESOLVED and is not asserted. PO-DEC-20 (directory visibility policy) pending. Confidence: High for our design |

### CAP-043 · Bulk messaging to staff

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-041 |
| **Entities** | — |
| **State machines** | — |
| **Architecture document** | [11](11-notifications-and-communications.md) |
| **Modules** | M-20 |
| **Primary data structures** | broadcast_records, broadcast_recipients *(created — CAR-020)* |
| **Interfaces / ports** | Email/SMS ports |
| **Background / async work** | Fan-out worker |
| **Real-time involvement** | No |
| **Authorization requirement** | Broadcasting requires an explicit capability — not everyone in a group may broadcast |
| **Privacy / security consideration** | T-12: **roster-only recipients**, rate-limited, audited with actor and recipient count |
| **Testing strategy** | QA: QA-SEC-013 · Sandbox: SBX-030a |
| **ADRs** | [ADR-0010](decisions/ADR-0010-notification-architecture.md) |
| **Open questions / confidence** | None outstanding. Confidence: High |

### CAP-056 · Group communication identity

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-056 |
| **Entities** | ENT-046 |
| **State machines** | — |
| **Architecture document** | [11](11-notifications-and-communications.md) |
| **Modules** | M-20 |
| **Primary data structures** | group_communication_identities |
| **Interfaces / ports** | Email port |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | Permitted-sender policy is explicit |
| **Privacy / security consideration** | Sender identity unambiguous — prevents the product becoming a phishing vector |
| **Testing strategy** | QA: QA-SEC-013 · Sandbox: SBX-030a |
| **ADRs** | [ADR-0010](decisions/ADR-0010-notification-architecture.md) |
| **Open questions / confidence** | C-11: the source's group email address has no application field; most plausibly out-of-band. **Unproven.** PO-DEC-21 pending. Confidence: Medium |

### CAP-044 · On-call access for telecom/switchboard

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-006, FEAT-011 |
| **Entities** | ENT-007 |
| **State machines** | — |
| **Architecture document** | [13](13-reports-calendars-and-documents.md) |
| **Modules** | M-21, M-22 |
| **Primary data structures** | on-call read model, calendar_feed_tokens |
| **Interfaces / ports** | — |
| **Background / async work** | Feed generation |
| **Real-time involvement** | No |
| **Authorization requirement** | **A dedicated minimal-scope role** — switchboard access must not imply schedule editing |
| **Privacy / security consideration** | **Minimum-necessary fields only**; no PII beyond the on-call name and contact route |
| **Testing strategy** | QA: QA-AUTH-006, QA-TEN-012 · Sandbox: SBX-001 |
| **ADRs** | [ADR-0004](decisions/ADR-0004-authorization-architecture.md) · [ADR-0014](decisions/ADR-0014-file-and-report-storage.md) |
| **Open questions / confidence** | No pending decision; the minimal-scope external role is a SchedulePoint design choice. Confidence: Medium-High |

### CAP-045 · Fairness statistics and variance

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | alpha |
| **Gate** | `G-PROD` |
| **Features** | FEAT-023 |
| **Entities** | ENT-017 |
| **State machines** | — |
| **Architecture document** | [13](13-reports-calendars-and-documents.md) |
| **Modules** | M-21 |
| **Primary data structures** | fairness_statistics read model, credits |
| **Interfaces / ports** | — |
| **Background / async work** | Statistics recomputation |
| **Real-time involvement** | No |
| **Authorization requirement** | Visibility of others' statistics is a capability, not a default |
| **Privacy / security consideration** | Fairness data is employment-sensitive |
| **Testing strategy** | QA: QA-RPT-002 · Sandbox: SBX-031a |
| **ADRs** | [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) |
| **Open questions / confidence** | **Normalisation formula is a SchedulePoint definition, not an observed one.** Confidence: Medium |

### CAP-046 · Reports: generation, print, export, sharing

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-024 |
| **Entities** | ENT-039 |
| **State machines** | — |
| **Architecture document** | [13](13-reports-calendars-and-documents.md) |
| **Modules** | M-21 |
| **Primary data structures** | report_runs *(+ `input_manifest`, `input_hash`, `policy_version` — CAR-012)*, report_artifacts, report_shares *(created — CAR-012)* |
| **Interfaces / ports** | Storage port |
| **Background / async work** | **Async generation worker** |
| **Real-time involvement** | Completion notification |
| **Authorization requirement** | Generated under the requester's context; **access re-checked at download** |
| **Privacy / security consideration** | T-10: short-lived signed URLs, per-tenant prefixes, expiry |
| **Testing strategy** | QA: QA-RPT-001 · Sandbox: SBX-031a |
| **ADRs** | [ADR-0014](decisions/ADR-0014-file-and-report-storage.md) |
| **Open questions / confidence** | Confidence: High |

### CAP-047 · Calendar feed subscription

| Field | Value |
|---|---|
| **Disposition** | SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR |
| **Milestone** | beta |
| **Gate** | `G-BETA` |
| **Features** | FEAT-042 |
| **Entities** | ENT-037 |
| **State machines** | STM-021 |
| **Architecture document** | [13](13-reports-calendars-and-documents.md) · [14](14-security-and-privacy.md) |
| **Modules** | M-22 |
| **Primary data structures** | calendar_feed_tokens (hash-stored) |
| **Interfaces / ports** | — |
| **Background / async work** | Feed rendering |
| **Real-time involvement** | No |
| **Authorization requirement** | Single-membership, read-only scope |
| **Privacy / security consideration** | T-09: **revocable, rotatable, no PII in the URL, owner notified on issue/rotate/revoke** — replacing the source's unrevocable token |
| **Testing strategy** | QA: QA-SEC-005, QA-SEC-009, QA-TEN-009 · Sandbox: SBX-031c |
| **ADRs** | [ADR-0014](decisions/ADR-0014-file-and-report-storage.md) |
| **Open questions / confidence** | Confidence: High |

### CAP-048 · Private document repository

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-050 |
| **Entities** | ENT-038, ENT-038b |
| **State machines** | STM-020 |
| **Architecture document** | [13](13-reports-calendars-and-documents.md) |
| **Modules** | M-23 |
| **Primary data structures** | documents, document_versions |
| **Interfaces / ports** | Storage port + malware-scan port |
| **Background / async work** | Scan-on-upload |
| **Real-time involvement** | No |
| **Authorization requirement** | Visibility level enforced server-side per document |
| **Privacy / security consideration** | T-11: **no public objects**, signed short-lived URLs, scan before availability, purge invalidates |
| **Testing strategy** | QA: QA-RPT-009, QA-SEC-010 · Sandbox: SBX-031b |
| **ADRs** | [ADR-0014](decisions/ADR-0014-file-and-report-storage.md) |
| **Open questions / confidence** | PO-DEC-22 (document retention — recommended policy-driven per organization, default indefinite) pending. Confidence: High |

### CAP-049 · Calendar events on the schedule

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-046 |
| **Entities** | ENT-014 |
| **State machines** | — |
| **Architecture document** | [13](13-reports-calendars-and-documents.md) |
| **Modules** | M-11, M-21 |
| **Primary data structures** | calendar_events |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | Push on change where a live view is open |
| **Authorization requirement** | Creation requires a scheduling capability |
| **Privacy / security consideration** | Event descriptions must carry no clinical content |
| **Testing strategy** | QA: — · Sandbox: SBX-031a |
| **ADRs** | [ADR-0007](decisions/ADR-0007-schedule-versioning.md) |
| **Open questions / confidence** | Confidence: Medium-High |

### CAP-055 · Hospital surgical-booking integration framework

| Field | Value |
|---|---|
| **Disposition** | REQUIRED PLATFORM CAPABILITY AND NAMED CONNECTOR |
| **Milestone** | beta |
| **Gate** | `G-ARCH` |
| **Features** | FEAT-055 |
| **Entities** | ENT-044, ENT-045 |
| **State machines** | STM-023 |
| **Architecture document** | [12](12-integrations-and-ingestion-privacy.md) |
| **Modules** | M-07, M-08 |
| **Primary data structures** | integration_connections, import_batches, connector_versions |
| **Interfaces / ports** | **Connector interface** |
| **Background / async work** | **Scheduled sync + manual retry** |
| **Real-time involvement** | No |
| **Authorization requirement** | Connection configuration requires an administrative capability |
| **Privacy / security consideration** | **Every import traverses M-08. No connector can bypass it — structurally** |
| **Testing strategy** | QA: QA-CON-003, QA-CON-009, QA-CON-010 · Sandbox: SBX-028 |
| **ADRs** | [ADR-0011](decisions/ADR-0011-ingestion-privacy-boundary.md) · [ADR-0012](decisions/ADR-0012-connector-architecture.md) |
| **Open questions / confidence** | PO-DEC-08 APPROVED. Confidence: High for the framework |

### CAP-061 · ORSOS connector

| Field | Value |
|---|---|
| **Disposition** | EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION |
| **Milestone** | post-beta |
| **Gate** | `G-CONN` |
| **Features** | FEAT-055 |
| **Entities** | ENT-044 |
| **State machines** | — |
| **Architecture document** | [12](12-integrations-and-ingestion-privacy.md) |
| **Modules** | M-07 |
| **Primary data structures** | integration_connections (kind=orsos) |
| **Interfaces / ports** | Connector interface |
| **Background / async work** | Sync job |
| **Real-time involvement** | No |
| **Authorization requirement** | As CAP-055 |
| **Privacy / security consideration** | Boundary applies identically |
| **Testing strategy** | QA: QA-CON-003 · Sandbox: SBX-028, SBX-029 |
| **ADRs** | [ADR-0012](decisions/ADR-0012-connector-architecture.md) |
| **Open questions / confidence** | **External specification required. No payload contract is invented here.** Confidence: N/A until the specification exists |

### CAP-062 · De-identification and ingestion privacy boundary

| Field | Value |
|---|---|
| **Disposition** | EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION |
| **Milestone** | beta |
| **Gate** | `G-CONN` |
| **Features** | FEAT-051, FEAT-062 |
| **Entities** | ENT-045 |
| **State machines** | STM-023 |
| **Architecture document** | [12](12-integrations-and-ingestion-privacy.md) |
| **Modules** | **M-08 — dependency-free** |
| **Primary data structures** | quarantined_records *(field paths, rejection codes, counts, value class — never values and never hashes; `import_quarantine` was the trace's name for this table — CAR-020/CAR-004)* |
| **Interfaces / ports** | **The boundary itself** |
| **Background / async work** | Applied inside batch processing |
| **Real-time involvement** | No |
| **Authorization requirement** | Platform-owned; no tenant configuration can weaken it |
| **Privacy / security consideration** | **Positive allowlist. Extends to storage, logs, errors, queues, audit, observability, and backups** |
| **Testing strategy** | QA: QA-PICK-017, QA-SEC-006 · Sandbox: SBX-029 |
| **ADRs** | [ADR-0011](decisions/ADR-0011-ingestion-privacy-boundary.md) |
| **Open questions / confidence** | **SBX-029 is the evidence.** Confidence: High on design, unproven in execution |

### CAP-063 · Cerner/Surginet connector

| Field | Value |
|---|---|
| **Disposition** | EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION |
| **Milestone** | post-beta |
| **Gate** | `G-CONN` |
| **Features** | FEAT-055 |
| **Entities** | ENT-044 |
| **State machines** | — |
| **Architecture document** | [12](12-integrations-and-ingestion-privacy.md) |
| **Modules** | M-07 |
| **Primary data structures** | integration_connections (kind=cerner) |
| **Interfaces / ports** | Connector interface |
| **Background / async work** | Sync job |
| **Real-time involvement** | No |
| **Authorization requirement** | As CAP-055 |
| **Privacy / security consideration** | Boundary applies identically |
| **Testing strategy** | QA: QA-CON-003 · Sandbox: SBX-028, SBX-029 |
| **ADRs** | [ADR-0012](decisions/ADR-0012-connector-architecture.md) |
| **Open questions / confidence** | External specification required. Confidence: N/A |

### CAP-064 · Meditech connector

| Field | Value |
|---|---|
| **Disposition** | EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION |
| **Milestone** | post-beta |
| **Gate** | `G-CONN` |
| **Features** | FEAT-055 |
| **Entities** | ENT-044 |
| **State machines** | — |
| **Architecture document** | [12](12-integrations-and-ingestion-privacy.md) |
| **Modules** | M-07 |
| **Primary data structures** | integration_connections (kind=meditech) |
| **Interfaces / ports** | Connector interface |
| **Background / async work** | Sync job |
| **Real-time involvement** | No |
| **Authorization requirement** | As CAP-055 |
| **Privacy / security consideration** | Boundary applies identically |
| **Testing strategy** | QA: QA-CON-003 · Sandbox: SBX-028, SBX-029 |
| **ADRs** | [ADR-0012](decisions/ADR-0012-connector-architecture.md) |
| **Open questions / confidence** | External specification required. Confidence: N/A |

### CAP-065 · Customer-specific connectors

| Field | Value |
|---|---|
| **Disposition** | REQUIRED PLATFORM CAPABILITY WITH CUSTOMER-SPECIFIC CONNECTOR |
| **Milestone** | post-production |
| **Gate** | `G-PROD` |
| **Features** | FEAT-055 |
| **Entities** | — |
| **State machines** | — |
| **Architecture document** | [12](12-integrations-and-ingestion-privacy.md) |
| **Modules** | M-07 |
| **Primary data structures** | integration_connections (kind=custom) |
| **Interfaces / ports** | Connector interface |
| **Background / async work** | Sync job |
| **Real-time involvement** | No |
| **Authorization requirement** | As CAP-055 |
| **Privacy / security consideration** | Boundary applies identically |
| **Testing strategy** | QA: QA-CON-003 · Sandbox: SBX-028 |
| **ADRs** | [ADR-0012](decisions/ADR-0012-connector-architecture.md) |
| **Open questions / confidence** | Per-engagement contract. Confidence: High for the framework |

### CAP-066 · Accessibility conformance

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | continuous |
| **Gate** | `G-PROD` |
| **Features** | FEAT-054 |
| **Entities** | — |
| **State machines** | — |
| **Architecture document** | [10](10-picklist-and-realtime.md) · [13](13-reports-calendars-and-documents.md) · [16](16-testing-and-environments.md) |
| **Modules** | **Cross-cutting — every UI module** |
| **Primary data structures** | — |
| **Interfaces / ports** | Design-system components |
| **Background / async work** | — |
| **Real-time involvement** | **Live-region announcements, throttled** |
| **Authorization requirement** | Accessibility is not gated by role — it applies to every surface |
| **Privacy / security consideration** | **A timed picklist turn must be completable via assistive technology** (SBX-033) |
| **Testing strategy** | QA: QA-A11Y-001 · Sandbox: SBX-032, SBX-033, SBX-034 |
| **ADRs** | [ADR-0002](decisions/ADR-0002-primary-technology-stack.md) |
| **Open questions / confidence** | SP-HR-3..6 observed in the source. **axe-core in CI is a build gate, not a report.** Confidence: High on approach, unproven in execution |

### CAP-067 · Request efficiency and performance

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | continuous |
| **Gate** | `G-BETA` |
| **Features** | FEAT-049 |
| **Entities** | — |
| **State machines** | — |
| **Architecture document** | [15](15-audit-and-observability.md) · [16](16-testing-and-environments.md) · [17](17-deployment-and-operations.md) |
| **Modules** | **Cross-cutting** |
| **Primary data structures** | — |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | Connection count scales with live features, not page views |
| **Authorization requirement** | — |
| **Privacy / security consideration** | **Requests-per-interaction budget fails CI** — the source fired ~25–40 identical requests per click (SP-HR-2) |
| **Testing strategy** | QA: QA-PERF-001 · Sandbox: SBX-030, SBX-031 |
| **ADRs** | [ADR-0002](decisions/ADR-0002-primary-technology-stack.md) |
| **Open questions / confidence** | Confidence: High on the mechanism, unmeasured in practice |

### CAP-068 · Privacy: no third-party identifier leakage

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-PROD` |
| **Features** | FEAT-052 |
| **Entities** | — |
| **State machines** | — |
| **Architecture document** | [14](14-security-and-privacy.md) |
| **Modules** | **Cross-cutting — M-25 policy** |
| **Primary data structures** | — |
| **Interfaces / ports** | — |
| **Background / async work** | — |
| **Real-time involvement** | No |
| **Authorization requirement** | — |
| **Privacy / security consideration** | **T-23: no email, email-derived hash, or equivalent identifier reaches any third party. CI fails the build on any new outbound host** |
| **Testing strategy** | QA: QA-SEC-001, QA-SEC-002, QA-SEC-003 · Sandbox: — |
| **ADRs** | [ADR-0002](decisions/ADR-0002-primary-technology-stack.md) |
| **Open questions / confidence** | **The one privacy failure the research observed directly.** Confidence: High |

### CAP-050 · Design-system safety contract

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | foundation |
| **Gate** | `G-BETA` |
| **Features** | FEAT-047, FEAT-048 |
| **Entities** | — |
| **State machines** | — |
| **Architecture document** | [07](07-schedule-and-publication.md) · [10](10-picklist-and-realtime.md) · [16](16-testing-and-environments.md) |
| **Modules** | **Cross-cutting — design system** |
| **Primary data structures** | — |
| **Interfaces / ports** | Component contract |
| **Background / async work** | — |
| **Real-time involvement** | — |
| **Authorization requirement** | — |
| **Privacy / security consideration** | **No control labelled Add, New, or Create persists anything before a completed form, validation, and an explicit Save** (I-13 — renumbered from the colliding `I-05`, CAR-023) |
| **Testing strategy** | QA: QA-PICK-003, QA-REQ-006 · Sandbox: SBX-020 |
| **ADRs** | [ADR-0002](decisions/ADR-0002-primary-technology-stack.md) |
| **Open questions / confidence** | **Directly derived from the Phase 8 safety incident**, in which such a control created a live record on click. Confidence: High |

### CAP-051 · Observability, backup, and recovery

| Field | Value |
|---|---|
| **Disposition** | REQUIRED FOR PRODUCTION |
| **Milestone** | beta |
| **Gate** | `G-PROD` |
| **Features** | FEAT-045, FEAT-053 |
| **Entities** | — |
| **State machines** | — |
| **Architecture document** | [15](15-audit-and-observability.md) · [17](17-deployment-and-operations.md) |
| **Modules** | M-24 + platform |
| **Primary data structures** | audit_events *(+ hash chain)*, audit_checkpoints *(created — CAR-014)*; backup and telemetry infrastructure |
| **Interfaces / ports** | Telemetry exporters |
| **Background / async work** | Backup, restore rehearsal |
| **Real-time involvement** | Connection metrics |
| **Authorization requirement** | Telemetry access is an operational, not tenant, concern |
| **Privacy / security consideration** | Ingestion payloads and notification bodies are never logged |
| **Testing strategy** | QA: QA-CON-012, QA-CON-013, QA-CON-014 · Sandbox: SBX-035 |
| **ADRs** | [ADR-0013](decisions/ADR-0013-audit-architecture.md) · [ADR-0015](decisions/ADR-0015-deployment-topology.md) |
| **Open questions / confidence** | **RPO/RTO not set** — requires product-owner input. Confidence: Medium |

---

## 3. Capabilities that block architecture approval

> **CORRECTED (CAR-020).** The manifest previously listed **five** architecture blockers while the authoritative [report 19](../../schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md) §5 lists **seven**. **CAP-003 and CAP-032 were omitted even though this document's own prose called them structural** — so governance could have reported the architecture gate complete while tenant isolation and picklist concurrency were unresolved. **All seven are listed below and all seven are addressed by this remediation.** Report 24 assigns CAP-003 and CAP-032 later *evidence* gates; that does not make them less architecturally blocking, and the two are no longer conflated.

| # | Capability | Why it blocks | Remediated by |
|---|---|---|---|
| 1 | **CAP-001** Organization tenancy root | The tenancy root determines every table, policy, and query. Changing it later is a rewrite | [SPEC-01](specs/SPEC-01-request-context-and-tenant-isolation.md), [ADR-0022](decisions/ADR-0022-request-scoped-tenant-context.md) |
| 2 | **CAP-002** Group scope and switching | Group scope is the unit of authorization and of nearly every read | [SPEC-01](specs/SPEC-01-request-context-and-tenant-isolation.md) §§2–3 |
| 3 | **CAP-003** **Tenant isolation** *(was omitted from the five)* | **The isolation primitives are load-bearing for every other capability. Two live failure paths were found (CAR-001, CAR-002)** | [SPEC-01](specs/SPEC-01-request-context-and-tenant-isolation.md), [ADR-0022](decisions/ADR-0022-request-scoped-tenant-context.md) |
| 4 | **CAP-006** Membership roles and capabilities | The authorization model governs every route and every row | [SPEC-06](specs/SPEC-06-authorization-truth-table.md) |
| 5 | **CAP-032** **Picklist concurrency and real-time state** *(was omitted from the five)* | **The turn transaction and event ordering cannot be retrofitted; the decisive invariant was wrong (CAR-003)** | [SPEC-02](specs/SPEC-02-picklist-turn-transaction.md), [ADR-0023](decisions/ADR-0023-picklist-turn-transaction.md) |
| 6 | **CAP-055** Integration framework | Determines where the ingestion boundary sits. Placing it wrongly is unrecoverable | [SPEC-03](specs/SPEC-03-raw-ingress-trust-boundary.md), [ADR-0021](decisions/ADR-0021-raw-ingress-enclave.md) |
| 7 | **CAP-057** Entitlement and feature gating | Entitlements must be separate from permissions from the first table, or the two entangle permanently | [SPEC-06](specs/SPEC-06-authorization-truth-table.md) §2.2 |

**CAP-062** (ingestion privacy boundary) carries a later gate but is architecturally structural for the same reason as CAP-055, and is designed here in full.

**None of the seven is *closed*.** Each is remediated in design and **awaits independent verification and the tests named in its specification.**

## 4. What this matrix does not establish

| It does not show | Because |
|---|---|
| That any capability works | **Nothing is implemented** |
| That any test passes | **No test has been executed** |
| That any gate is met | **No gate is passed** |
| That the source product behaves this way | Every design here is SchedulePoint's own; source behaviour classified `UNRESOLVED` stays `UNRESOLVED` |
| That named connectors can be built | **Each requires an external specification not in hand** |

**This matrix establishes exactly one thing: that no capability was lost between the baseline and the architecture.**
