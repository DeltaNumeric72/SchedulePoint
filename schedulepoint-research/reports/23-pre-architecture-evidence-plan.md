# 23 — Pre-Architecture Evidence Plan

**Created 2026-07-31.** Extends [18-targeted-sandbox-test-plan.md](18-targeted-sandbox-test-plan.md) with what is needed to reach **defensible functional completeness**.

**Product name:** `SchedulePoint` — **PO-DEC-00 APPROVED**.

> **Status 2026-07-31.** The four architecture-gating decisions (`PO-DEC-02`, `PO-DEC-18`, `PO-DEC-04`, `PO-DEC-08`) are **APPROVED** and the architecture-definition phase is **unblocked**. **No sandbox test in this plan has been executed**, no production-completeness gate has passed, and no connector-certification gate has passed.

---

## 1. What this plan is for

Thirteen research phases were constrained to read-only observation of a live production system. That constraint was correct, and it leaves a residue: a set of behaviours that are **structurally evidenced but behaviourally unknown**.

This plan states, for every missing environment or external specification: **what it proves · what cannot be proven without it · who would normally provide it · whether architecture, implementation, or production can proceed without it · acceptable temporary assumptions · required later validation.**

> **Standing rule: an untested assumption is never described as confirmed functionality.** Where this plan permits work to proceed on an assumption, the assumption is named, its risk is stated, and its validation is scheduled.

---

## 2. Environments

### E-01 · Mutable synthetic source test organization *(if obtainable)*
**Proves:** the source's actual behaviour for the twelve lifecycles that were never observable — build execution, request creation surfaces, picklist execution, notification delivery, role visibility.
**Cannot be proven without it:** what iSchedule.MD *actually does*. Every such question stays `UNRESOLVED` as a source fact.
**Normally provided by:** the vendor, under written authorization naming tenant, window, and permitted actions.
**Architecture may proceed:** **yes.** SchedulePoint's design is specified independently in reports 19–21; this environment would *inform*, not gate.
**Implementation may proceed:** yes.
**Production may proceed:** yes.
**Temporary assumption:** the SchedulePoint designs in reports 19–21 stand on their own merit and are validated against SchedulePoint's own implementation.
**Later validation:** if obtained, re-run SBX-001, 010, 015, 021, 030a to compare source behaviour against our assumptions and record any divergence as new evidence.
**Status:** **desirable, not required.** Its absence does not block anything — a point worth being explicit about, since it is the single largest evidence gap.

### E-02 · MULTI — multi-tenant environment
**Proves:** tenant isolation, per-membership role divergence, cross-tenant denial, directory population rules.
**Cannot be proven without it:** that isolation holds. **This is the one property that cannot be assumed.**
**Provided by:** the SchedulePoint team.
**Architecture:** **no — architecture cannot be finalised without a plan to test isolation.** **Implementation:** yes. **Production:** **no.**
**Temporary assumption:** none permitted. Isolation is asserted only when tested.
**Later validation:** SBX-001, 003, 004.

### E-03 · CONC — concurrency environment
**Proves:** races resolve to exactly one winner — approvals on the last entitlement unit, simultaneous opportunity claims, concurrent publication, simultaneous room selection.
**Cannot be proven without it:** that the concurrency design works. Single-session testing cannot detect a race.
**Provided by:** the SchedulePoint team.
**Architecture:** **no.** The concurrency strategy (optimistic concurrency, atomic conditional claims, period-scoped serialisation) must be decided before the data layer is built. **Implementation:** yes. **Production:** **no.**
**Temporary assumption:** the strategy in [19](19-schedulepoint-production-capability-baseline.md) CAP-032 and the QA-CON series is sound by construction — **a design argument, not evidence.**
**Later validation:** SBX-013, 014b, 018, 022 — each repeated ≥50× with orchestrated timing. A single pass is not evidence.

### E-04 · LIVE-SIM — simulated live picklist
**Proves:** the entire picklist execution surface — the product's signature feature and **the largest unobserved area in the research**.
**Cannot be proven without it:** turn advancement, timers, remaining-choice review, confirmation, skip, proxy action, administrator intervention, reconnection.
**Provided by:** the SchedulePoint team (controllable clock, injectable network faults, scriptable advancement).
**Architecture:** **no — C-04's transport decision needs it.** **Implementation:** partially; the domain model is specified. **Production:** **no.**
**Temporary assumption:** the STM-013/STM-014 lifecycles are correct in shape. **Explicitly an assumption** — eleven of twenty-five state machines carry Low confidence, and these two are among them.
**Later validation:** SBX-020..027.

### E-05 · PERF — performance environment
**Proves:** solver performance and quality across six benchmark datasets; request-efficiency budgets (**SP-HR-2**); real-time connection cost at scale.
**Cannot be proven without it:** whether the §8 targets in [21](21-automated-scheduling-production-requirements.md) are achievable.
**Provided by:** the SchedulePoint team.
**Architecture:** yes, with a caveat — if the solver cannot meet targets, the engine architecture may need revisiting, so early smoke benchmarking is prudent. **Implementation:** yes. **Production:** **no.**
**Temporary assumption:** the conservative targets in [21](21-automated-scheduling-production-requirements.md) §8.3 are achievable. Deliberately set below the public claim.
**Later validation:** SBX-030, 031.

### E-06 · A11Y — accessibility environment
**Proves:** conformance to **SP-HR-3..6**, against the four measurable failures the source exhibits.
**Cannot be proven without it:** that keyboard and screen-reader users can complete critical workflows — including **a timed picklist turn**, which is an exclusion risk rather than an inconvenience.
**Provided by:** the SchedulePoint team (screen readers, forced-colors, 400% zoom, real devices).
**Architecture:** yes. **Implementation:** yes, but conformance must be continuous, not a final sweep. **Production:** **no.**
**Temporary assumption:** none — accessibility is verified continuously from the first component.
**Later validation:** SBX-032, 033, 034.

### E-07 · DR — disaster-recovery environment
**Proves:** point-in-time restore, migration safety, RTO/RPO, **audit-history integrity through a restore**.
**Provided by:** the SchedulePoint team.
**Architecture:** yes. **Implementation:** yes. **Production:** **no.**
**Temporary assumption:** standard managed-database recovery guarantees apply.
**Later validation:** SBX-035.

### E-08 · INTEG — integration sandbox
**Proves:** import validation, idempotency, reconciliation, failure handling, and **the de-identification boundary**.
**Cannot be proven without it:** that patient-level content cannot enter the platform (**C-09**).
**Provided by:** the SchedulePoint team, using **wholly fabricated** payloads shaped like the named external systems. **No real payload, and no real case data, ever.**
**Architecture:** **no — the ingestion boundary is an architectural component.** **Implementation:** yes. **Production:** connector release only.
**Temporary assumption:** a positive allow-list schema is sufficient. **Must be tested with identifying fields in unexpected positions**, not only expected ones.
**Later validation:** SBX-028, 029.

---

## 3. Test accounts, roles, and synthetic data

**Accounts:** as defined in [18](18-targeted-sandbox-test-plan.md) §3 — ten synthetic accounts spanning all six role tiers, plus a cross-tenant account and an account holding **different roles in two groups** (the per-membership divergence case).

**Synthetic data required:**

| Fixture | Contents |
|---|---|
| Schedule fixtures | Small / medium / large / multi-site / large-rule-set / multi-stage datasets ([21](21-automated-scheduling-production-requirements.md) §8.2) |
| Request and vacation fixtures | All request types incl. ON, OFF, No Call, shift preference; both vacation modes; quota boundary and over-quota cases |
| Qualification fixtures | Valid, expiring, expired, and revoked credentials; a shift type requiring one; a **future-dated assignment against a credential that expires before it** |
| Picklist fixtures | Lists in all three modes; a list with exclusions and a proxy grant |
| Integration fixtures | Valid, malformed, partially-invalid, duplicate, and conflicting payloads |
| **De-identification fixtures** | Payloads carrying **fabricated** patient-shaped fields in **expected and unexpected positions**, plus free-text fields containing fabricated identifiers |
| Report fixtures | Datasets producing known-correct statistics for assertion |
| Calendar-feed fixtures | Issued, rotated, and revoked tokens |
| Document fixtures | Files across categories and visibility levels; a superseded version; a purged document |
| Accessibility fixtures | Every form in an invalid state; a live timed picklist turn |

**Absolute rule:** **no real patient data, no real staff data, no real customer organization name enters any environment, ever** — including screenshots and logs.

---

## 4. Controlled notification endpoints

**Mandatory before any notification test runs.** As defined in [18](18-targeted-sandbox-test-plan.md) §4: catch-all test mailbox with plus-addressing · programmable virtual SMS numbers · a programmable voice endpoint that answers, records, and discards · **push test-device tokens on a dedicated sandbox project** (new for CAP-041).

**Rule:** if a test cannot prove its destination is controlled, the test does not run. **No real person is ever contacted.**

---

## 5. External specifications required

| Specification | Proves | Provided by | Arch? | Impl? | Prod? | Temporary assumption | Later validation |
|---|---|---|---|---|---|---|---|
| **ORSOS payload contract** | connector correctness | hospital IT + system vendor | yes | yes | **connector release only** | a canonical internal schema with a per-connector adapter absorbs shape differences | SBX-028 per connector |
| **Cerner/Surginet contract** | as above | as above | yes | yes | **connector release only** | as above | SBX-028 |
| **Meditech contract** | as above | as above | yes | yes | **connector release only** | as above | SBX-028 |
| **Customer definition of identifying fields** | that de-identification is correct **for that customer** | hospital privacy office | yes | yes | **connector release only** | the conservative field list in [20](20-contradiction-resolution-register.md) C-09 is a floor, not a ceiling | SBX-029 + privacy sign-off |
| **Push provider terms** | deliverability and retention | platform vendor | yes | yes | yes | standard provider guarantees | SBX-030b |
| **Voice/SMS provider terms** | deliverability, cost, jurisdiction | platform vendor | yes | yes | **no** | standard provider guarantees | SBX-030a |

**Critically:** the absence of every one of these blocks **connector release only** — **not architecture, not implementation, and not production of the core product.** The integration framework (CAP-055) is built against a canonical internal schema; connectors adapt to it. This is deliberate: it means no hospital's IT timeline gates SchedulePoint's own release.

---

## 6. What can and cannot proceed

### Architecture — **UNBLOCKED 2026-07-31**

The decisions that gated architecture are **approved**: `PO-DEC-02` (authorization model) · `PO-DEC-18` (real-time transport) · `PO-DEC-04` (entitlement architecture, technical) · `PO-DEC-08` (de-identification ownership). See [24](24-production-completeness-gates.md) §5.

**The SchedulePoint architecture-definition phase is ready to begin.**

Three things remain distinct and must not be conflated:

| Stage | Status |
|---|---|
| The design decisions | **Approved** |
| The architectural work | **Not started** — layering, real-time topology, entitlement model, and ingestion boundary all still to be designed |
| Implementation and verification | **Future work** — nothing built, nothing verified |

Still to be decided **as part of architecture itself** (design work, not blocking approvals): concurrency strategy · audit model · tenancy implementation · storage and retention design · observability design.

**These were decisions, not evidence — and approving them is not evidence either.** No sandbox test in this plan has been executed.

### Implementation may proceed with
The full capability baseline, domain model, and state machines — **provided** every assumption carrying Low confidence is implemented behind a test that will later confirm or refute it, and is not described as confirmed in the meantime.

### Production may not proceed without
Every `G-PROD` gate in [24-production-completeness-gates.md](24-production-completeness-gates.md), which requires E-02 through E-07 and the tests they host.

### Connector release may not proceed without
E-08, the per-connector external specification, and **SBX-029 de-identification evidence with privacy sign-off**.

---

## 7. Assumptions register

Every assumption permitting work to proceed, with its risk and validation.

| # | Assumption | Risk if wrong | Validated by | Blocks if unvalidated |
|---|---|---|---|---|
| A-01 | STM-013/014 picklist lifecycles are correct in shape | Rework of the signature feature | SBX-021 | Production |
| A-02 | Concurrency strategy resolves all identified races | Double-booking; lost turns | SBX-013, 014b, 022 | Production |
| A-03 | Conservative solver targets are achievable | Engine architecture revisit | SBX-031 | Production |
| A-04 | A positive allow-list is sufficient for de-identification | Patient data enters the platform | SBX-029 | **Connector release** |
| A-05 | A canonical import schema absorbs connector differences | Per-connector core changes | SBX-028 | Connector release |
| A-06 | Four-layer authorization is sufficient and comprehensible | Authorization defects; C-02 reproduced | SBX-002 | Architecture sign-off |
| A-07 | Push is deliverable reliably enough to be a primary channel | Notification story narrower than advertised | SBX-030b | Beta |
| A-08 | Qualification eligibility on the assignment date is the correct rule | Unqualified assignment | SBX-019 | Production |
| A-09 | Directory-visibility policy matches operational expectations | Directory omits people who should appear | SBX-003 | Beta |
| A-10 | Group broadcast identity is outbound-first | Rework if inbound replies are needed | customer feedback | — |

**None of these is described as confirmed functionality anywhere in this corpus.**

**Approval status note (2026-07-31).** A-02, A-04 and A-06 relate to designs that are now **approved** (`PO-DEC-18`, `PO-DEC-08`, `PO-DEC-02` respectively). **Approval does not discharge the assumption** — each remains unvalidated until its named test passes, and each still blocks what the table says it blocks. An approved design that has not been tested is still an assumption.

---

## 8. Cross-references

Tests — [18](18-targeted-sandbox-test-plan.md) · Capabilities — [19](19-schedulepoint-production-capability-baseline.md) · Contradictions — [20](20-contradiction-resolution-register.md) · Engine — [21](21-automated-scheduling-production-requirements.md) · Traceability — [22](22-functional-traceability-matrix.md) · Gates — [24](24-production-completeness-gates.md)
