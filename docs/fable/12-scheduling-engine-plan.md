# 12 — Scheduling Engine Plan

**The engine is a distinct product and technical domain, planned as such.** Requirements authority: report 21. Normative design: SPEC-04, doc 08, ADR-0006/0020. This document is the delivery plan and my reasoned recommendation on the initial-release question.

---

## 1. The recommendation the mandate requires

**Implement incrementally with a real solver from the start: OR-Tools CP-SAT in the separately-packaged Python worker, behind the solver-neutral `SolverPort`, delivered in three engine increments (E1→E3) inside milestones M2–M6 — with manual scheduling shipped first (M3) as the permanent override/fallback capability, never as the product's production answer.**

Why this and not the alternatives:

| Option | Verdict |
|---|---|
| Fully reproduce the source engine | **Impossible and prohibited** — the algorithm was never observed (clean-room); there is nothing to reproduce |
| Begin with manual scheduling only, add the solver later | **Rejected as a release strategy** — C-08/I-05 make automated generation the production mechanism; a manual-only product repeats the exact scope error AMD-17 corrected. But manual scheduling *ships first in sequence* (M3) because the publication pipeline needs content before the solver exists, and because manual override is a permanent production capability anyway |
| Third-party scheduling SaaS/solver service | **Rejected** — sends tenant scheduling data to an external processor for the product's core function; adds a vendor boundary at the heart of the domain; and the constraint classes (pattern spacing, named-individual rules) map directly onto CP-SAT anyway |
| Custom optimization model (own heuristic/metaheuristic) | **Rejected as primary** — cannot *prove* hard-constraint satisfaction or infeasibility; those are two absolute production requirements (report 21). Retained as the hybrid warm-start evolution once benchmarks justify it |
| **CP-SAT incrementally (chosen)** | Native hard constraints; first-class `INFEASIBLE`; Apache-2.0; integer modelling is a manageable, make-once decision. The `SolverPort` keeps MIP/hybrid as adapter swaps |

## 2. Scope of the domain (inputs → outputs)

**Inputs:** period (Mon–Sun); demand (shift requirements per day per shift type); people (memberships, eligibility from qualifications + valid groups, weekday FTE targets, max assignments, work %); rules (typed AST: pattern rules, staff rules with five action types, position restrictions, group weights — each `HARD` or weighted `SOFT`); request/vacation constraints (via projection, never raw statuses); pinned/protected assignments; holiday calendar; history (for fairness normalisation).

**Outputs:** a candidate build with — full assignment set; per-constraint satisfaction record; **zero unauthorized hard violations (absolute)**; conflict list by severity taxonomy (PO-DEC-13); fairness/quality metrics vs the twelve acceptance criteria; explanation object (tiered); reproducibility record (seed, image digest, params, worker count, compiler version).

**Lifecycle:** the 16-state build machine — `infeasible` (proven; explained) is not `failed` (engine error); progressive builds fill around pins; rebuilds compare candidates per-configuration (D-4 rescope); publication is a separate lifecycle (SPEC-05) consuming a chosen candidate.

**Explainability (a product feature, not telemetry):** four bounded tiers, from named-rule attribution up to relaxation search; `EXPLANATION_BUDGET_EXCEEDED` / `EXPLANATION_UNAVAILABLE` are honest first-class outcomes; a bare success/failure flag is a spec violation. The withdrawn promises (minimal infeasibility cores, dominated alternatives) stay withdrawn.

**Hard/soft discipline in three places:** CHECK constraint in data; compiler has no path from `HARD` to an objective term; independent re-validation of every returned solution rejects any hard violation as a build-rejecting defect.

**Overnight shifts, DST, holidays:** modelled in group timezone with explicit day-boundary rules (A-07); holiday behaviour from `group_holidays`; these are E1 model decisions, made once.

## 3. Delivery increments

| Increment | Content | Milestone | Exit evidence |
|---|---|---|---|
| **E0 — Spike SP-5** | Serialize → solve → cancel → timeout → kill → restart → reproduce round-trip on a toy problem; RPC contract; determinism-vs-worker-count measured; TDG-11 closed | M0 | Spike report + repeatable harness |
| **E1 — Model core** | Rule AST + compiler (unmapped node fails CI); demand/eligibility/FTE encoding; integer scaling decision; hard constraints + basic objective; independent re-validator; B-* benchmark corpus **built** (fixtures with known-by-construction properties, incl. `B-infeasible-*`) | M2 (corpus) → M4 | S-01t..S-16t subset; corpus committed |
| **E2 — Production lifecycle** | 16-state machine wired; progressive builds around pins; cancellation layers; reproducibility record; tier-1/2 explanations; conflict taxonomy; quality criteria computed | M4 | SBX-015/016/017; `hard_violations = 0` absolute on all feasible corpus runs |
| **E3 — Quality & fairness** | Fairness normalisation (documented formula, visible to schedulers); weights tuning surface; tier-3/4 explanations within budgets; candidate comparison; performance vs report 21 §8.3 conservative targets (PO-DEC-23) | M6 | SBX-030/031; acceptance bands **defined from corpus runs, then frozen** |

**Benchmark bands rule (ratified from CAR-006):** bands are undefined until the corpus runs — E3 defines them from measured runs and only then are they acceptance criteria. Speed is never reported without its paired quality measure; the public ~2,700-cells claim is never repeated as ours.

## 4. Engine-specific risks & controls

RISK-01 (quality/time on real-sized problems) → E0 measures early, port keeps MIP/hybrid open, conservative published targets. RISK-02 (unusable explanations) → `B-infeasible-*` oracle fixtures + scheduler usability review in beta. RISK-29 (second language) → accepted; separate image/SBOM; one-solve-per-subprocess so kill is always enforceable. Determinism under parallelism **measured at E0 (EV-M0-SPC)**: seed+worker-count insufficient; reproducible builds pin the deterministic portfolio + deterministic time limits + full parameter set (SPEC-04 amendment); deterministic-mode cost measured on the E1 corpus before defaults freeze. T1 explanations = separate budgeted failable solve. Cancellation = watcher-thread StopSearch; never signals. Solver image pins Python 3.12; harness re-run under 3.12 in CI closes E0. Solver worker holds **no database credential** — problem in, solution out, over versioned authenticated RPC.
