# RISK-REGISTER (live)

Seeded from docs/architecture/19 §1 (RISK-01..31, ratified) + [../18-risk-register.md](../18-risk-register.md) (NR-1..NR-8). Reviewed at every milestone exit.

**Updates 2026-08-01 (delegated-authority mandate):**
- RISK-22 (no independent review) — **partially retired:** internal adversarial verification commissioned and dispositioned ([../22-readiness-assessment.md](../22-readiness-assessment.md)); residual (external perspective) carried until the required pre-beta external review (blocking beta entry, V-04). NR-5 re-scoped to that review's outcome.
- RISK-19 / NR-8 — **retired as blocking:** decisions resolved with recorded reversibility; benchmark-band guard (bands must be at or under report-21 targets) is now a rule, not a pending ratification.
- RISK-25 (residency) — **mitigated by design:** provisional ca-central-1 posture adopted (OI-3/4); residual until procurement.
- NR-3 (stale doc-02 sentence) — **retired:** F-05 corrected.
- **NR-9 (new):** a provisional technology selection (TDG row) fails its M0 confirmation spike — affected row reopens; bounded churn. L: low-med, I: med. Retired by: OPUS-M0-001/003 + M0 wiring evidence.
- **NR-10 (new):** the internal review's shared model family under-finds defects that the executable harnesses also miss. L: low, I: high. Mitigation: T/P/V harnesses are the decisive evidence; required external review blocks beta entry. Retired by: harness executions + external review.

Currently elevated (watch list): EV-1 vendor specs (long lead, G-CONN) · NR-4 sub-agent quality variance (begins mattering at M0) · NR-10.
- **NR-11 (new, FD-6):** compromise of a connector-scoped enclave HMAC key re-identifies external-reference pseudonyms. L: low, I: high. Mitigation: key custody in the enclave's separate trust domain (E-14), rotation with dual-pseudonym window; raw references never stored. Retired by: key-custody verification in SBX-029 sweeps.
- **Internal verification (2026-08-01):** 29 findings dispositioned, corrections applied ([../../architecture/remediation/internal-verification-corrections.md](../../architecture/remediation/internal-verification-corrections.md)); corrections are design-only until harnesses run.
