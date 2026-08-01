# 04 — Research Decision

**Decision: accept the existing research. Conduct no additional iSchedule.md investigation for this planning mandate. Broad source research remains permanently closed.**

I had standing authority to investigate read-only whenever it would improve the specification or plan. I exercised the judgement that authority implies: I evaluated each candidate investigation and rejected all of them. Being permitted to research is not a reason to research.

---

## 1. The test I applied

A new source investigation is justified only if **all four** hold:

1. A specific product or architecture decision is currently blocked or materially uncertain;
2. The missing evidence is observable read-only, within the safety policy;
3. The evidence would plausibly change the decision (not merely decorate it);
4. The expected value exceeds the risk of touching a live production healthcare tenant again — which now includes an **active live picklist** in one group membership.

## 2. Candidate investigations evaluated

| Candidate | 1. Blocked decision? | 2. Read-only observable? | 3. Decision-changing? | Verdict |
|---|---|---|---|---|
| Live picklist execution (gap #1) | Design exists (SPEC-02) | **No.** Watching a live draft means observing real clinical operations in real time; any interaction risks affecting a live turn; and passive observation still couldn't produce the concurrency evidence we need | Races/atomicity can only be proven in our own harness | **REJECT — prohibited in substance.** LIVE-SIM + SBX-020..027 replace it |
| Re-open report dialogs (gap #5) | No — SPEC-09 defines our reports independently | Mostly | No: our report model is snapshot-based by design, deliberately unlike the source | REJECT |
| Non-Scheduler role views (gap #3) | No | **No** — requires credentials/roles never available; impersonation prohibited | — | REJECT — impossible |
| Form validation behaviour (gap #4) | No | **No** — requires submissions | — | REJECT — prohibited |
| Build execution (gap #6) | No — report 21 is deliberately our own model | **No** — running a build mutates | — | REJECT — prohibited |
| Re-verify public claims (report 17 refresh) | No decision hangs on marketing copy dated 2026-07-30 (2 days old) | Yes | No | REJECT — staleness negligible |
| Targeted re-check of the three Group Settings fields (GAP report 17) | No — all three already documented and mapped | Yes | No | REJECT |

**Every remaining Unknown is Unknown because observing it requires a mutating action, a privilege we don't hold, or a live clinical process we must not touch.** That is a structural property of the read-only policy, not a coverage failure. Further navigation cannot convert any of them.

## 3. What replaces further research

The evidence burden moves from *observation of the source* to *proof in our own environments* — which is where it always had to end up for a clean-room product:

- **Design-stage proofs:** SPEC-01 T-tests, SPEC-02 P-tests, SPEC-05 V-tests at the schema/prototype stage (roadmap M0–M1).
- **Sandbox evidence:** the 39 SBX tests across MULTI/CONC/LIVE-SIM/PERF/A11Y/DR/INTEG environments, each with a SPEC-16 nine-field evidence contract.
- **Benchmark evidence:** the B-* solver corpus (built at M2, run from M4).
- **Customer-shaped validation:** scheduler usability review of infeasibility explanations (RISK-02) and the controlled-vocabulary workflow (RISK-30) during beta.

## 4. Standing conditions for any future source contact

Any future iSchedule.md interaction requires: a written question this plan cannot answer; a specific screen list; a read-only action list with prohibited actions named; my approval recorded in [control/PRODUCT-DECISIONS.md](control/PRODUCT-DECISIONS.md); and RESEARCH-RULES.md in force unchanged. **The active production picklist is never opened under any future authorization.** Comparison QA at playbook Phase 23 (re-observing workflows read-only to compare against SchedulePoint) is the one anticipated legitimate future use, and it will be scoped then, not pre-authorized now.
