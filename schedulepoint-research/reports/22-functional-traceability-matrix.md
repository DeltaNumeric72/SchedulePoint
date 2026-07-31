# 22 — Functional Traceability Matrix

**Created 2026-07-31.** Companion to [19-schedulepoint-production-capability-baseline.md](19-schedulepoint-production-capability-baseline.md).

**Product name:** `SchedulePoint` — **PO-DEC-00 APPROVED**.

**This matrix is generated from the reports themselves, not hand-authored.** Every row was extracted programmatically from report 19's capability blocks and cross-checked against reports 11, 13, 14, 15, 17, and 18. It is re-derivable and therefore machine-checkable.

---

## 1. Chain

`source evidence → public claim → capability → glossary term → feature → entity → state machine → QA case → sandbox test → implementation milestone → production gate`

**No row uses an unexplained blank.** Where a relationship genuinely does not apply, the cell reads `NOT APPLICABLE` **with a stated reason**.

**Glossary column:** terminology is normalised across the whole corpus rather than per-capability, so this column points to [12-product-glossary.md](12-product-glossary.md) (88 terms) rather than repeating term IDs on every row. Per-capability term usage is traceable through the Feature and Entity columns, both of which carry term references in their own reports.

## 2. Gate keys

| Gate | Meaning |
|---|---|
| `G-ARCH` | Must be satisfied before architecture is finalised |
| `G-BETA` | Must be satisfied before controlled beta |
| `G-PROD` | Must be satisfied before production release |
| `G-CONN` | Must be satisfied before any hospital connector is certified for release |

Gate definitions and evidence requirements: [24-production-completeness-gates.md](24-production-completeness-gates.md).

---

## 3. Capability traceability

| Capability | Name | Public claim | Glossary | Feature | Entity | State machine | QA case | Sandbox test | Milestone | Production disposition | Gate |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CAP-001 | Organization tenancy root | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-002 | ENT-001 | `NOT APPLICABLE` — no lifecycle | QA-TEN-001, QA-TEN-005, QA-TEN-006 | SBX-004 | foundation | `REQUIRED FOR PRODUCTION` | G-ARCH |
| CAP-002 | Group scheduling scope and switching | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-001 | ENT-002, ENT-006 | `NOT APPLICABLE` — no lifecycle | QA-TEN-002 | SBX-001, SBX-004 | foundation | `REQUIRED FOR PRODUCTION` | G-ARCH |
| CAP-003 | Server- and database-enforced tenant isolati | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-003 | ENT-001, ENT-002, ENT-006 | `NOT APPLICABLE` — no lifecycle | QA-SEC-008, QA-TEN-005 | SBX-004 | foundation | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-004 | Site (physical location) modelling | PUB-019 | see [12](12-product-glossary.md) | FEAT-004 | ENT-003 | `NOT APPLICABLE` — no lifecycle | `NOT APPLICABLE` — no QA case written; covered by the referenced capability tests | SBX-019 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-005 | User accounts and account types | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-005 | ENT-004, ENT-005 | STM-017, STM-018 | QA-AUTH-005, QA-AUTH-011, QA-SEC-014 | SBX-005 | foundation | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-006 | Membership-scoped roles and capabilities | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-006 | ENT-006, ENT-007, ENT-008 | `NOT APPLICABLE` — no lifecycle | QA-AUTH-006, QA-TEN-003 | SBX-001, SBX-002 | foundation | `REQUIRED FOR PRODUCTION` | G-ARCH |
| CAP-007 | Self-service profile, credentials, and prefe | PUB-070 | see [12](12-product-glossary.md) | FEAT-007 | ENT-004, ENT-005, ENT-009 | `NOT APPLICABLE` — no lifecycle | QA-AUTH-004, QA-SEC-011, QA-SEC-014 | SBX-005 | foundation | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-008 | Authentication and session management | PUB-067, PUB-068, PUB-069, PUB-070 | see [12](12-product-glossary.md) | FEAT-008 | ENT-004 | STM-017 | QA-AUTH-001, QA-AUTH-012, QA-AUTH-013 | SBX-005, SBX-006 | foundation | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-009 | Invitation and activation, separated from pa | PUB-069 | see [12](12-product-glossary.md) | FEAT-005, FEAT-008 | ENT-004, ENT-006 | STM-017 | QA-AUTH-004 | SBX-005 | foundation | `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` | G-BETA |
| CAP-010 | Administrative impersonation | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-009 | ENT-004, ENT-040 | `NOT APPLICABLE` — no lifecycle | QA-AUTH-010 | SBX-005 | beta | `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` | G-BETA |
| CAP-011 | Shift type catalogue | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-010 | ENT-011 | `NOT APPLICABLE` — no lifecycle | QA-SCH-004, QA-SCH-006, QA-SCH-013 | SBX-015 | foundation | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-012 | Shift groups and staff groups | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-013, FEAT-014 | ENT-012, ENT-013 | `NOT APPLICABLE` — no lifecycle | QA-REQ-003, QA-SCH-006 | SBX-010 | foundation | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-013 | Weekday-variable FTE, maximum assignments, w | PUB-003, PUB-004, PUB-005, PUB-012 | see [12](12-product-glossary.md) | FEAT-013 | ENT-006, ENT-011 | `NOT APPLICABLE` — no lifecycle | QA-SCH-006 | SBX-015, SBX-031 | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-014 | Schedule periods and versioned publication | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-015, FEAT-018, FEAT-019 | ENT-015, ENT-016 | STM-003, STM-004 | QA-CON-010, QA-SCH-001 | SBX-018 | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-015 | Automated schedule generation | PUB-001, PUB-002, PUB-015, PUB-017 | see [12](12-product-glossary.md) | FEAT-016 | ENT-023b, ENT-024, ENT-025b | STM-001 | QA-CON-002, QA-SCH-001 | SBX-015, SBX-031 | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-016 | Rule engine: patterns, staff rules, position | PUB-006, PUB-007, PUB-008, PUB-009, PUB-010, PUB-011, PUB-012, PUB-014 | see [12](12-product-glossary.md) | FEAT-017 | ENT-021, ENT-022, ENT-023, ENT-023b, ENT-048 | `NOT APPLICABLE` — no lifecycle | QA-SCH-005, QA-SCH-006 | SBX-015, SBX-016 | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-017 | Progressive builds around fixed assignments | PUB-013 | see [12](12-product-glossary.md) | FEAT-016 | ENT-024 | STM-001, STM-002 | QA-SCH-002 | SBX-017 | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-018 | Partial-schedule circulation | PUB-013 | see [12](12-product-glossary.md) | FEAT-016 | ENT-016 | STM-002 | QA-SCH-001 | SBX-017 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-019 | Manual scheduling, override, and fixed assig | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-012, FEAT-027 | ENT-014, ENT-017 | STM-004 | QA-CON-001, QA-SCH-008 | SBX-017, SBX-018 | foundation | `ADMINISTRATIVE FALLBACK OR OVERRIDE` | G-BETA |
| CAP-020 | Schedule viewing, three views, and daily ass | PUB-059 | see [12](12-product-glossary.md) | FEAT-011, FEAT-033 | ENT-014 | `NOT APPLICABLE` — no lifecycle | QA-A11Y-006, QA-SCH-010 | SBX-033, SBX-034 | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-021 | Requests: ON, OFF, No Call, shift preference | PUB-020, PUB-021 | see [12](12-product-glossary.md) | FEAT-020 | ENT-018, ENT-025 | STM-005, STM-006 | QA-REQ-001, QA-REQ-013 | SBX-010, SBX-011 | alpha | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-022 | Vacation: quota/grant mode and open mode | PUB-022, PUB-023 | see [12](12-product-glossary.md) | FEAT-021 | ENT-019, ENT-020, ENT-021b | STM-007 | QA-REQ-002, QA-REQ-007 | SBX-012, SBX-013 | alpha | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-023 | Vacation commit to schedule | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-022 | ENT-016, ENT-019 | STM-007 | QA-CON-003, QA-CON-010, QA-REQ-010 | SBX-012 | alpha | `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` | G-BETA |
| CAP-024 | Opportunity board with email fan-out | PUB-024 | see [12](12-product-glossary.md) | FEAT-025 | ENT-026 | STM-008 | QA-OPP-001 | SBX-013b, SBX-014b | beta | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-025 | Staff preference over locums for extra work | PUB-025 | see [12](12-product-glossary.md) | FEAT-025 | ENT-006, ENT-026 | STM-008 | QA-OPP-002, QA-OPP-003 | SBX-013b | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-026 | Shift offers, swaps, and transfers with opti | PUB-026, PUB-028 | see [12](12-product-glossary.md) | FEAT-026, FEAT-027 | ENT-027, ENT-028 | STM-009, STM-010, STM-011 | QA-OPP-009 | SBX-014c | beta | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-027 | Schedule-change audit and affected-staff not | PUB-027 | see [12](12-product-glossary.md) | FEAT-045 | ENT-040 | `NOT APPLICABLE` — no lifecycle | QA-AUTH-009, QA-CON-011, QA-SCH-015 | SBX-018, SBX-030a | foundation | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-030 | Picklist preparation | PUB-037, PUB-038 | see [12](12-product-glossary.md) | FEAT-030 | ENT-029, ENT-030, ENT-031 | STM-012 | QA-PICK-001, QA-PICK-015 | SBX-020 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-031 | Picklist execution | PUB-029, PUB-039, PUB-042, PUB-043, PUB-046, PUB-048 | see [12](12-product-glossary.md) | FEAT-031, FEAT-032 | ENT-029, ENT-030, ENT-032 | STM-013, STM-014 | QA-A11Y-014, QA-PICK-005 | SBX-021, SBX-024, SBX-027 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-032 | Picklist concurrency and real-time state | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-032, FEAT-035 | `NOT APPLICABLE` — no persistent entity | STM-013, STM-014 | QA-CON-004, QA-PICK-005 | SBX-022, SBX-023 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-033 | Administrator picklist intervention and moni | PUB-044, PUB-045 | see [12](12-product-glossary.md) | FEAT-032, FEAT-035 | `NOT APPLICABLE` — no persistent entity | STM-013 | QA-PICK-008, QA-PICK-013 | SBX-025 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-034 | Proxy delegation | PUB-041 | see [12](12-product-glossary.md) | FEAT-034 | ENT-010 | STM-019 | QA-AUTH-008 | SBX-026 | beta | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-040 | Notification delivery, escalation, retry, an | PUB-040, PUB-047 | see [12](12-product-glossary.md) | FEAT-040 | ENT-034, ENT-035, ENT-035b | STM-015, STM-016 | QA-CON-009, QA-NOT-001 | SBX-030a | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-041 | Notification channels: email, SMS, voice, pu | PUB-040, PUB-051, PUB-061 | see [12](12-product-glossary.md) | FEAT-040, FEAT-061 | ENT-047 | STM-025 | QA-NOT-005, QA-NOT-011 | SBX-030a, SBX-030b | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-042 | Contacts directory with minimised PII | PUB-052 | see [12](12-product-glossary.md) | FEAT-041 | ENT-004, ENT-005 | `NOT APPLICABLE` — no lifecycle | QA-SEC-014 | SBX-003 | alpha | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-043 | Bulk messaging to staff | PUB-052 | see [12](12-product-glossary.md) | FEAT-041 | `NOT APPLICABLE` — no persistent entity | `NOT APPLICABLE` — no lifecycle | QA-SEC-013 | SBX-030a | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-044 | On-call access for telecom/switchboard | PUB-050 | see [12](12-product-glossary.md) | FEAT-006, FEAT-011 | ENT-007 | `NOT APPLICABLE` — no lifecycle | QA-AUTH-006, QA-TEN-012 | SBX-001 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-045 | Fairness statistics and variance | PUB-055, PUB-057 | see [12](12-product-glossary.md) | FEAT-023 | ENT-017 | `NOT APPLICABLE` — no lifecycle | QA-RPT-002 | SBX-031a | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-046 | Reports: generation, print, export, sharing | PUB-055, PUB-056 | see [12](12-product-glossary.md) | FEAT-024 | ENT-039 | `NOT APPLICABLE` — no lifecycle | QA-RPT-001 | SBX-031a | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-047 | Calendar feed subscription | PUB-058 | see [12](12-product-glossary.md) | FEAT-042 | ENT-037 | STM-021 | QA-SEC-005, QA-SEC-009, QA-TEN-009 | SBX-031c | beta | `SUPERSEDED BY SAFER SCHEDULEPOINT BEHAVIOUR` | G-BETA |
| CAP-048 | Private document repository | PUB-054 | see [12](12-product-glossary.md) | FEAT-050 | ENT-038, ENT-038b | STM-020 | QA-RPT-009, QA-SEC-010 | SBX-031b | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-049 | Calendar events on the schedule | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-046 | ENT-014 | `NOT APPLICABLE` — no lifecycle | `NOT APPLICABLE` — no QA case written; covered by the referenced capability tests | SBX-031a | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-050 | Design-system safety contract | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-047, FEAT-048 | `NOT APPLICABLE` — no persistent entity | `NOT APPLICABLE` — no lifecycle | QA-PICK-003, QA-REQ-006 | SBX-020 | foundation | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-051 | Observability, backup, and recovery | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-045, FEAT-053 | `NOT APPLICABLE` — no persistent entity | `NOT APPLICABLE` — no lifecycle | QA-CON-012, QA-CON-013, QA-CON-014 | SBX-035 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-055 | Hospital surgical-booking integration framew | PUB-032, PUB-033, PUB-034, PUB-036 | see [12](12-product-glossary.md) | FEAT-055 | ENT-044, ENT-045 | STM-023 | QA-CON-003, QA-CON-009, QA-CON-010 | SBX-028 | beta | `REQUIRED PLATFORM CAPABILITY AND NAMED CONNECTOR` | G-ARCH |
| CAP-056 | Group communication identity | PUB-053 | see [12](12-product-glossary.md) | FEAT-056 | ENT-046 | `NOT APPLICABLE` — no lifecycle | QA-SEC-013 | SBX-030a | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-057 | Entitlement and feature gating | PUB-062, PUB-063, PUB-064 | see [12](12-product-glossary.md) | FEAT-057 | ENT-041 | STM-024 | QA-AUTH-007, QA-TEN-005 | SBX-002 | foundation | `REQUIRED FOR PRODUCTION` | G-ARCH |
| CAP-058 | Qualifications, credentials, expiry, and eli | PUB-018 | see [12](12-product-glossary.md) | FEAT-058 | ENT-011, ENT-042, ENT-043 | STM-022 | QA-SCH-006 | SBX-019 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-059 | Conflict detection and build-quality verific | PUB-016, PUB-057 | see [12](12-product-glossary.md) | FEAT-059 | ENT-025b, ENT-026b | STM-002 | QA-SCH-002, QA-SCH-005 | SBX-016 | alpha | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-060 | Picklist operating modes: paper, manual-entr | PUB-030, PUB-031, PUB-032 | see [12](12-product-glossary.md) | FEAT-060 | ENT-029 | STM-012 | QA-PICK-001 | SBX-020 | beta | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-061 | ORSOS connector | PUB-033 | see [12](12-product-glossary.md) | FEAT-055 | ENT-044 | `NOT APPLICABLE` — no lifecycle | QA-CON-003 | SBX-028, SBX-029 | post-beta | `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` | G-CONN |
| CAP-062 | De-identification and ingestion privacy boun | PUB-035 | see [12](12-product-glossary.md) | FEAT-051, FEAT-062 | ENT-045 | STM-023 | QA-PICK-017, QA-SEC-006 | SBX-029 | beta | `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` | G-CONN |
| CAP-063 | Cerner/Surginet connector | PUB-033 | see [12](12-product-glossary.md) | FEAT-055 | ENT-044 | `NOT APPLICABLE` — no lifecycle | QA-CON-003 | SBX-028, SBX-029 | post-beta | `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` | G-CONN |
| CAP-064 | Meditech connector | PUB-033 | see [12](12-product-glossary.md) | FEAT-055 | ENT-044 | `NOT APPLICABLE` — no lifecycle | QA-CON-003 | SBX-028, SBX-029 | post-beta | `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` | G-CONN |
| CAP-065 | Customer-specific connectors | PUB-014, PUB-065 | see [12](12-product-glossary.md) | FEAT-055 | `NOT APPLICABLE` — no persistent entity | `NOT APPLICABLE` — no lifecycle | QA-CON-003 | SBX-028 | post-production | `REQUIRED PLATFORM CAPABILITY WITH CUSTOMER-SPECIFIC CONNECTOR` | G-PROD |
| CAP-066 | Accessibility conformance | PUB-060 | see [12](12-product-glossary.md) | FEAT-054 | `NOT APPLICABLE` — no persistent entity | `NOT APPLICABLE` — no lifecycle | QA-A11Y-001 | SBX-032, SBX-033, SBX-034 | continuous | `REQUIRED FOR PRODUCTION` | G-PROD |
| CAP-067 | Request efficiency and performance | PUB-017, PUB-046, PUB-060 | see [12](12-product-glossary.md) | FEAT-049 | `NOT APPLICABLE` — no persistent entity | `NOT APPLICABLE` — no lifecycle | QA-PERF-001 | SBX-030, SBX-031 | continuous | `REQUIRED FOR PRODUCTION` | G-BETA |
| CAP-068 | Privacy: no third-party identifier leakage | `NOT APPLICABLE` — no public claim; authenticated or SchedulePoint-decision origin | see [12](12-product-glossary.md) | FEAT-052 | `NOT APPLICABLE` — no persistent entity | `NOT APPLICABLE` — no lifecycle | `NOT APPLICABLE` — no QA case written; covered by the referenced capability tests | `NOT APPLICABLE` — verified by automated CI assertion, not a sandbox scenario | foundation | `REQUIRED FOR PRODUCTION` | G-PROD |
---

## 4. Public-claim coverage
**70 public claims. 68 map to at least one capability; 2 are explicitly `NOT APPLICABLE` with a stated reason** (see [19](19-schedulepoint-production-capability-baseline.md) §4a).
**Unmapped public claims: none**

## 5. Sandbox-test coverage
**39 sandbox tests defined. 39 are referenced by at least one capability.**
All defined sandbox tests are referenced.

## 6. Contradiction coverage
| Contradiction | Resolution | Status |
|---|---|---|
| C-01 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-01 | recommended resolution recorded |
| C-02 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-02 | recommended resolution recorded |
| C-03 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-03 | recommended resolution recorded |
| C-04 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-04 | recommended resolution recorded |
| C-05 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-05 | recommended resolution recorded |
| C-06 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-06 | recommended resolution recorded |
| C-07 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-07 | recommended resolution recorded |
| C-08 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-08 | recommended resolution recorded |
| C-09 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-09 | recommended resolution recorded |
| C-10 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-10 | recommended resolution recorded |
| C-11 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-11 | recommended resolution recorded |
| C-12 | [20-contradiction-resolution-register.md](20-contradiction-resolution-register.md) §C-12 | recommended resolution recorded |

**All twelve contradictions have a recommended resolution.** None is left as "more research needed".

## 7. External integration coverage
| Capability | Specification / certification requirement |
|---|---|
| CAP-055 Integration framework | Platform required for production; **connector certification** required per named system |
| CAP-061 ORSOS | `EXTERNAL SPECIFICATION REQUIRED BEFORE CONNECTOR CERTIFICATION` — payload contract, auth, direction, scheduling |
| CAP-063 Cerner/Surginet | as above |
| CAP-064 Meditech | as above |
| CAP-065 Customer-specific | per-engagement contract |
| CAP-062 De-identification boundary | **`G-CONN` gate — no connector ships until demonstrated with test evidence (SBX-029)** |

## 8. Gate distribution
| Gate | Capabilities |
|---|---:|
| `G-ARCH` | 5 |
| `G-BETA` | 15 |
| `G-PROD` | 34 |
| `G-CONN` | 4 |

**Total capabilities: 58. Every capability carries exactly one gate.**

## 9. Validation assertions
This matrix is re-derivable. The following are asserted and machine-checked in the Phase validation run:

- Every PUB ID maps to a capability **or** carries an explicit `NOT APPLICABLE` reason
- Every FEAT ID maps to at least one capability
- Every capability maps to acceptance testing (a QA case, a sandbox test, or an explained `NOT APPLICABLE`)
- Every capability carries exactly one production disposition and exactly one gate
- Every production-required capability maps to a production or connector gate
- Every contradiction maps to a resolution
- Every external integration maps to a specification or certification requirement
- No row contains an unexplained blank
