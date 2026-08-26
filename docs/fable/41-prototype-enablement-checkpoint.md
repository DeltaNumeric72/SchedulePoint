# 41 — Prototype-enablement checkpoint record

**Recorded 2026-08-25 by the Fable orchestrator under the continuous GitHub master
authorization (2026-08-22).** This is the checkpoint the owner's supersession ruling
placed between the replacement gate and M5: "When the replacement gate passes, complete
M3R and continue automatically into the prototype checkpoint and M5."

## 1. Preconditions, verified

- The replacement gate PASSED with all eleven §9 criteria closed by evidence
  ([39](39-replacement-gate-decision.md)); **M3R is CLOSED by substitution** (owner §C).
- `main` is at the gate-records merge (`548aa24`, PR #7; the repair-phase merge
  `be7399b`, PR #6) with **CI fully green** (run 32798497944, 15/15, attempt 1 — the
  first fully green `main` in the repository's history) and fresh-clone validation
  green end to end.
- Milestone tags `milestone/M1..M4` are published on GitHub and independently verified
  (issue #1 CLOSED). The 58-capability baseline is intact; no capability was dropped,
  deferred-without-a-gate, or narrowed anywhere in the review or its repairs.

## 2. What this checkpoint ENABLES

- **The internal prototype posture:** the M1–M4 system (tenancy kernel, authz, audit,
  catalogue, rules, publication, staff views, authn, automated scheduling with real
  CP-SAT, the critical-path UI at both viewports) may be operated end to end as an
  **internal development prototype** — local or ephemeral environments, **synthetic
  data only**, controlled notification endpoints only, exactly as every battery and
  the real-stack e2e already operate it. Nothing new is switched on; this records
  that the posture is now a sanctioned standing state rather than a test-only event.
- **M5 execution begins** under the continuous authorization and the within-milestone
  autonomy of [24-execution-standards](24-execution-standards.md) §G: entry register
  and packet pre-declaration in [42](42-m5-entry-and-prerequisite-register.md),
  Fable orchestrating, Opus executing, one accepted commit per packet, independent
  review and delta verification on every packet, serialized merges.

## 3. What remains OWNER-RESERVED (unchanged, verbatim scope)

Purchases and contracts · production accounts, domains, and credentials ·
real-hospital connections · real personal or clinical data · real notifications ·
legal representations · production deployment. **The prototype posture is not a
deployment**: no production release, no external users, no real data of any kind, no
claim of HIPAA/PHIPA/SOC 2/ISO 27001/GDPR compliance or readiness
([14](../architecture/14-security-and-privacy.md) §11). The client-side
third-party-host prohibition (CAP-068/T-23) and every non-bypass rule are unchanged.

## 4. Standing risks and follow-ups carried in

The durable register [40](40-post-gate-follow-ups.md) rides into M5: **FU-01 (NR-22
retirement) is bound SAME-MILESTONE and is scheduled in M5's opening packet**
([42](42-m5-entry-and-prerequisite-register.md) §4); NR-20/NR-23 measurements and the
remainder follow their recorded bindings. The elevated watch list (NR-4 reviewer-value
variance above all) continues to justify the mandatory independent review on every
M5 packet.
