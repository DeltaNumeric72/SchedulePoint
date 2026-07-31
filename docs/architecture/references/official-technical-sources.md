# Official Technical Sources

Primary-source documentation consulted while preparing this architecture proposal. **Only official primary documentation was used.** No marketing material, blog posts, or unsourced comparisons informed any decision here.

**Rule applied throughout:** a *documented fact* is what the official source states; an *architectural recommendation* is our judgement about what to do with it. The two are labelled separately in every architecture document.

| # | Source | URL | Accessed | Documented facts relied upon |
|---|---|---|---|---|
| S-01 | Google OR-Tools — CP-SAT solver overview | `https://developers.google.com/optimization/cp/cp_solver` | 2026-07-31 | CP-SAT is a constraint-programming solver designed for integer programming problems. It supports both feasibility and **optimization** objectives. All constraints must be expressed over integers; non-integer terms must be scaled. Solver status values are `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `MODEL_INVALID`, `UNKNOWN`. Multiple solutions can be enumerated via a callback with `enumerate_all_solutions`. |
| S-02 | Google OR-Tools — licence | `https://github.com/google/or-tools/blob/stable/LICENSE` | 2026-07-31 | OR-Tools is distributed under the **Apache License, Version 2.0**. |
| S-03 | PostgreSQL — Row Security Policies | `https://www.postgresql.org/docs/current/ddl-rowsecurity.html` | 2026-07-31 | RLS is enabled per table with `ALTER TABLE … ENABLE ROW LEVEL SECURITY`. With RLS enabled and **no** policy present, a **default-deny** applies. Policies may be per-command and per-role. Permissive policies combine with `OR`; restrictive policies combine with `AND`. **Table owners normally bypass row security** unless `FORCE ROW LEVEL SECURITY` is set. **Superusers and roles with `BYPASSRLS` always bypass** row security. `TRUNCATE` and `REFERENCES` are **not** subject to row security. |

## Consequences drawn from these facts

**From S-03 — this materially shapes the tenancy design.** Row-level security is a valuable *defence in depth* layer but is **not** sufficient on its own:

- The application must **never** connect as a superuser, as a `BYPASSRLS` role, or as the owning role of the tenant tables — otherwise every policy is silently bypassed. See [05-tenancy-entitlements-authorization.md](../05-tenancy-entitlements-authorization.md) §4.
- Owner-bypass means migration and administrative connections need a **separate role** from the application runtime role.
- Because `TRUNCATE` and `REFERENCES` escape RLS, destructive DDL-adjacent operations must be controlled by role grants, not by policy.
- Default-deny on an RLS-enabled table with no policy is a useful property: a newly added tenant table that nobody has written a policy for **fails closed** rather than leaking.

**From S-01/S-02 — this shapes the solver decision.** CP-SAT's documented support for optimization objectives (not merely satisfiability) and its explicit `INFEASIBLE` status are directly relevant to two production requirements: weighted soft preferences, and distinguishing *infeasible* from *failed*. Apache-2.0 licensing is compatible with a commercial product. See [ADR-0006](../decisions/ADR-0006-solver-architecture.md).

**Not verified here.** Anything the official sources did not state is treated as unknown and is **not asserted anywhere in this proposal**. In particular, the CP-SAT overview page did not document parallelism, solution hints, or assumption-based infeasibility analysis; where the architecture depends on such behaviour it says so and routes the question to a benchmark (SBX-031) rather than assuming it.

**Technology choices whose official documentation was not consulted for this proposal** are marked in [02-technology-stack.md](../02-technology-stack.md) with a confidence level and, where the choice is load-bearing, an ADR requiring verification before adoption. Their maturity and licensing claims are **recommendations pending verification**, not documented facts.
