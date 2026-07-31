# ADR-0006 — Automated Scheduling Solver Architecture

**Status:** `PROPOSED` — 2026-07-31. Not accepted.

## Context

Automated schedule generation is the product's central promise. **The source product's algorithm is not known**, was never observed in execution, and is explicitly not reproduced — reproducing it would breach the clean-room boundary even if it were known.

The problem is a constrained assignment problem: assign staff to shifts subject to hard constraints (qualifications, rest, coverage, position restrictions) while optimising soft objectives (fairness, preference satisfaction, pattern adherence). Real instances involve hundreds of staff over multi-week horizons.

## Decision

**A solver-neutral domain model behind a `SolverPort` interface, with OR-Tools CP-SAT as the recommended first implementation.**

The domain expresses constraints and objectives in its own vocabulary — named rules, not solver syntax. Translation into a solver model happens entirely inside the adapter. **No domain module imports the solver**, and CI enforces that.

**Verified facts (S-01, S-02):** CP-SAT is a constraint-programming solver supporting optimization, returning `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `MODEL_INVALID`, and `UNKNOWN`; OR-Tools is Apache-2.0 licensed. **The five status values map directly onto the build lifecycle** — in particular, `FEASIBLE` and `UNKNOWN` are distinct outcomes a scheduler must be able to tell apart, and collapsing them into "done" would misrepresent a timed-out run as a completed one.

**Two properties are non-negotiable:**

1. **Explainability.** An `INFEASIBLE` result triggers a constraint-relaxation search producing a minimal infeasibility core, reported as **named rules a scheduler recognises** — not as solver internals.
2. **Reproducibility.** Every run pins the solver version, a fixed random seed, and a hash of its inputs, so a result can be regenerated exactly.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| **MIP solver** | Strong for linear objectives; weaker for the scheduling-specific structure (sequences, patterns, rest windows) that CP handles natively. Commercial solvers add licence cost |
| **Custom heuristic** (greedy, tabu, simulated annealing) | Fast and controllable, but **cannot prove infeasibility and cannot explain it** — and explanation is what schedulers actually need |
| **Hybrid: heuristic warm start + CP-SAT** | **Not rejected — deferred.** A legitimate optimisation once benchmarks show where time is spent. The port makes it addable |
| **Reproducing the source's approach** | Unknown, and would breach the clean-room boundary |

## Consequences

**Positive:** the solver is replaceable without touching a domain module · CP-SAT's status values map to a lifecycle a scheduler can understand · Apache-2.0 imposes no licence cost · explainability is designed in rather than retrofitted.

**Negative:** **solver performance on real-sized problems is entirely unproven (RISK-01)** · CP-SAT runs outside the Node.js runtime, requiring a process boundary · constraint translation is intricate and a rich source of subtle bugs · the relaxation search for infeasibility cores is itself expensive.

## Security implications

Solver inputs contain **no patient data** — the ingestion boundary (ADR-0011) guarantees the work items reaching a build carry none. **Models are never logged in full**; run summaries carry counts and outcomes. Per-organization concurrency caps prevent one tenant's large build from exhausting solver capacity for everyone.

## Operational implications

Scheduling workers are a separate process class with their own scaling profile. A killed run is marked `failed`, never silently lost, and is **re-runnable from the same pinned inputs**. Timeouts are configurable per organization. A runbook for stuck runs is required before production and does not yet exist.

## Capability mappings

CAP-015, CAP-016, CAP-017, CAP-059 directly; CAP-013, CAP-058, CAP-045 as inputs.

## Gate mappings

`G-PROD` — CAP-015..CAP-017, CAP-059. Tests: SBX-030, SBX-031.

## Unresolved validation

- **No benchmark has been run. Every performance statement is an expectation.**
- PO-DEC-23 (solver performance targets) is pending.
- PO-DEC-13 (conflict-severity taxonomy) is pending.
- Whether infeasibility cores are *usable* by a real scheduler is unvalidated (RISK-02).
