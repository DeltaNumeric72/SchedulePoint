# SPEC-04 — Solver Runtime, Rule Model, and Evidence Contract

**Status: `PROPOSED`.** Remediates **CAR-005** (High) and **CAR-006** (High).
**Supersedes:** [02](../02-technology-stack.md) §1 "one runtime across all four process classes"; [08](../08-automated-scheduling-engine.md) §§1–7; [06](../06-data-architecture.md) invariant **D-4**.
**ADRs:** [ADR-0006](../decisions/ADR-0006-solver-architecture.md) (revised), [ADR-0020](../decisions/ADR-0020-solver-runtime-packaging.md) (new).

> **What was wrong.**
> **(CAR-005)** ADR-0002 selected "Node.js/TypeScript across all four process classes" and one image; ADR-0006 said CP-SAT runs outside Node.js. **Verified fact S-04: OR-Tools ships official bindings for C++, Python, Java, and C# only — not Node.js.** The two ADRs contradicted each other and neither defined the runtime, protocol, packaging, cancellation channel, or security boundary that the contradiction implies.
> **(CAR-006)** `ScheduleProblem.constraints: Constraint[]` is a type name, not a rule language. Weekday FTE and maximum-assignment data had no canonical home. Cooperative cancellation polling cannot interrupt a blocking native solve. "Minimal infeasibility core" and per-assignment "dominated alternative" rationales were promised without a bound. D-4 allowed only one non-terminal build per period, making candidate comparison impossible.

---

## 1. Runtime decision (CAR-005)

**Decision: a separately packaged Python solver worker running OR-Tools CP-SAT, communicating with the platform over a versioned protocol.**

| Option | Assessment |
|---|---|
| **Python solver worker** — **SELECTED** | Officially supported (S-04); the reference language for CP-SAT examples and the richest callback surface; cheap to package |
| Java or C# worker | Also officially supported; heavier images; no advantage here |
| C++ worker | Best control and lowest overhead; slowest to build and hardest to staff |
| Node.js native binding | **Rejected — no official binding exists (S-04).** A community binding would put an unsupported FFI layer under the product's central algorithm |
| A different solver with a Node binding | Considered; none reviewed offers CP-SAT's constraint expressiveness for this problem class under a permissive licence. **Revisit only if benchmarking rejects CP-SAT** |

**Consequences accepted explicitly:**

- **The "one language, one image" claim in ADR-0002 is withdrawn.** The platform is TypeScript in four process classes **plus Python in the solver worker**. Saying so is the remediation; pretending otherwise was the defect.
- A second language means a second dependency chain, SBOM, patch stream, and security review ([SPEC-11](SPEC-11-audit-assurance-and-security-boundaries.md) §7).
- The domain remains solver-neutral. **No domain module imports the solver or knows it is Python** — CI enforces this.

### 1.1 Packaging and boundaries

| Aspect | Design |
|---|---|
| **Deployment unit** | Its own image and its own process class ([SPEC-10](SPEC-10-deployment-topology.md) §2) |
| **Interface** | Versioned RPC over an authenticated internal channel. **Not** a shared database, **not** a shared filesystem |
| **Solver worker holds no database credential** | It receives a problem, returns a result. It cannot read or write tenant tables |
| **Tenant context propagation** | Every request carries `organization_id`, `group_id`, `build_run_id`, and `correlation_id`, and the worker echoes them on every log line and span. **They are labels for attribution, not authorization** — authorization happened before dispatch |
| **Authentication** | Mutual authentication on the internal channel; the worker rejects unauthenticated requests |
| **Resource isolation** | CPU and memory limits per solve; per-organization concurrency cap; a saturated pool queues rather than degrading the web tier |
| **Observability** | Structured logs and spans with counts, durations, and outcomes. **The model is never logged in full**; a model dump is written only to a build-scoped, access-controlled artifact when explicitly requested for support |

### 1.2 Protocol version compatibility

`SolveRequest` and `SolveResponse` carry `protocol_version`. The worker accepts a bounded window of versions and **rejects anything outside it rather than guessing**. Rolling deploys are therefore safe in both directions, and a protocol change is a deliberate, reviewed event.

---

## 2. Cancellation, timeout, and interruption (CAR-006)

**A cooperative flag polled by the caller cannot interrupt a blocking native solve.** Three mechanisms, layered, because the first two can fail:

| # | Mechanism | Covers |
|---|---|---|
| **1** | **Solver-native deadline.** The solve is submitted with a hard time limit set from the build configuration | The ordinary case: the solver returns by itself, with a status |
| **2** | **Solver callback.** A per-solution / periodic callback checks a cancellation flag set by the worker's control channel and requests solver stop | User-initiated cancellation during a long solve |
| **3** | **Process termination.** One solve occupies one worker subprocess. If 1 and 2 do not return within a grace period, the **subprocess is killed** | A wedged or unresponsive native solve |

**Mechanism 3 is what makes cancellation a guarantee rather than a hope.** Its cost is that the subprocess boundary is mandatory: a solve that shares a process with the worker's control loop cannot be killed without killing the control loop.

| Property | Design |
|---|---|
| **Killed solve** | `build_runs.state = 'cancelled'` or `'failed'` with `termination_reason ∈ {deadline, user_cancelled, killed, crashed}`. **Never silently lost** |
| **Re-runnable** | From the same pinned `solver_inputs` snapshot and the same recorded parameters |
| **Retry semantics** | A retry is a **new `build_run`** with a new id and the same `input_hash`, linked by `retry_of_build_run_id`. **Retries are never in-place** |
| **Retry limit** | Bounded; exhausted retries surface to the scheduler with the last `termination_reason` |
| **Verified-status mapping** | CP-SAT's `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `MODEL_INVALID`, `UNKNOWN` (S-01) map to distinct build outcomes. **`FEASIBLE` and `UNKNOWN` are never collapsed into "done"** — a timed-out run must not be reported as a completed one |

---

## 3. The rule model (CAR-006)

### 3.1 A typed, versioned rule AST

**Rules are stored as a typed abstract syntax tree with a schema version, not as free-form constraint objects.**

```
Rule
├── rule_id, rule_key, name, rule_schema_version
├── classification: HARD | SOFT            -- see §3.3
├── weight?                                 -- SOFT only; HARD must be NULL
├── scope: { group, date_range?, shift_types[]?, staff_groups[]?, memberships[]? }
└── predicate: RuleNode

RuleNode = one of the closed set below. There is no "custom expression" node.
```

| Node family | Nodes | Report-21 rule class |
|---|---|---|
| **Coverage** | `RequiredCount`, `MinCoverage`, `MaxCoverage` | Demand satisfaction |
| **Eligibility** | `RequiresQualification(qualification, valid_at=shift_date)`, `MemberOfStaffGroup`, `ValidGroupRestriction`, `PickPositionRestriction` | Qualification and eligibility |
| **Capacity** | `MaxAssignmentsInWindow`, **`WeekdayFteLimit`**, `WorkPercentageTarget`, `MaxConsecutive` | FTE, maximum assignments, work percentage |
| **Rest and spacing** | `MinimumRestBetween`, `CallSpacing`, `NoAdjacent`, `ForbiddenSequence` | Rest and call spacing |
| **Pattern** | `PatternRule(trigger, days_of_week, segments)`, `AlternatingWeek`, `TemplateAdherence(template, cycle)` | Patterns and templates |
| **Linkage** | `LinkedShifts`, `ImpliesAssignment`, `MutuallyExclusive` | Linked shifts |
| **Preference** | `RequestHonoured(type)`, `ShiftPreference(strength)`, `AvoidDate` | Requests and preferences |
| **Fairness** | `FairnessBalance(metric, normalisation)`, `CreditDistribution` | Fairness |
| **Locum** | `StaffOverLocumPriority(window)`, `LocumRestriction` | Locum rules |
| **Fixed** | `FixedAssignment(assignment_identity)`, `ProtectedRange` | Fixed assignments, progressive builds |

**The node set is closed.** A rule the AST cannot express is a **schema change with a migration**, not an escape hatch. That is the property that makes compilation, validation, and migration possible at all.

### 3.2 Compiler and migrations

| Stage | Behaviour |
|---|---|
| **Authoring validation** | A rule is validated against the AST schema on save. An invalid rule **cannot be stored** |
| **Compilation** | `RuleAST → SolverModel` inside the adapter. **A node with no compiler mapping is a build-time error in CI**, not a runtime surprise |
| **Compiler determinism** | The same AST plus the same data produces the same model, byte for byte |
| **Schema migration** | `rule_schema_version` is stored per rule. A migration transforms stored ASTs forward, is reversible where possible, and is **tested against a corpus of every node type** |
| **Unmapped legacy rule** | Blocks the build with a named error. **It is never silently dropped and never silently softened** |

### 3.3 The hard/soft invariant

**A `HARD` rule can never be relaxed, downgraded, weighted, or skipped by any code path.**

| Enforcement | Mechanism |
|---|---|
| Data | `CHECK (classification = 'HARD' AND weight IS NULL) OR (classification = 'SOFT' AND weight IS NOT NULL)` |
| Compiler | `HARD` compiles to a solver constraint; `SOFT` compiles to an objective term. **The compiler has no path from `HARD` to an objective term** |
| Relaxation search | Operates **only** on the `SOFT` set and on an explicitly enumerated relaxable-hard set used *solely* for explanation (§5) — never to produce a returned schedule |
| Result validation | Every returned solution is **re-validated against every `HARD` rule** by an independent checker before it can become a schedule version. A violation fails the build |
| Test | A property test asserts no compiler input classified `HARD` yields a relaxable model element |

**Result re-validation is deliberate redundancy.** Trusting the solver to have honoured what we asked would make a translation bug indistinguishable from a correct schedule.

### 3.4 Canonical input data — the missing tables

**`membership_work_profiles` is created.** The traceability document referenced it; the schema did not define it (CAR-020).

| Table | Key fields | Constraints |
|---|---|---|
| **`membership_work_profiles`** *(NEW)* | `membership_id`, `effective_from`, `effective_to?`, `work_percentage`, `max_assignments_per_week?`, `max_assignments_per_period?`, `max_consecutive_days?` | `UNIQUE (membership_id, effective_from)`; non-overlapping validity ranges enforced by exclusion constraint; `0 < work_percentage <= 100` |
| **`membership_weekday_fte`** *(NEW)* | `work_profile_id`, `weekday (0–6)`, `fte_fraction`, `max_assignments?` | `UNIQUE (work_profile_id, weekday)`; `0 <= fte_fraction <= 1` |
| **`work_item_labels`** *(NEW)* | See [SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) §4.1 | — |

**Effective-dated, because a person's FTE changes and a historical build must be reproducible against the profile that was in force.**

`solver_inputs` captures a **complete immutable snapshot**: requirements, rule ASTs with their schema versions, work profiles and weekday FTE as of the build date, qualification holdings with validity, approved requests and vacation, fixed assignments, prior-period history used for fairness, and the build configuration. `input_hash` covers all of it.

---

## 4. Reproducibility — what is and is not promised

| Recorded per build | Purpose |
|---|---|
| `input_hash` | The problem |
| `rule_schema_versions[]` | The rule language |
| `solver_version` | The library |
| **`solver_image_digest`** | The exact binary, by content digest |
| **`solver_parameters`** (full serialised set) | Including time limit and search strategy |
| **`deterministic_worker_count`** | Parallelism affects search order |
| **`random_seed`** | The seed |
| `compiler_version` | The AST→model translation |
| `platform_arch` | Architecture affects floating-point and threading behaviour |

**The promise, stated exactly:**

> **Bit-identical reproduction is guaranteed only for the same `input_hash`, `solver_image_digest`, `solver_parameters`, `deterministic_worker_count`, `random_seed`, `compiler_version`, and `platform_arch`.**
> **Across a solver upgrade or a different worker count, reproduction is not promised and must not be claimed.**

| Consequence | Handling |
|---|---|
| Historical reproduction needs the historical image | Solver images are **retained by digest** for the audit-retention window. **Cost and registry retention are a named operational obligation** ([SPEC-10](SPEC-10-deployment-topology.md) §8) |
| A retained image eventually becomes unpatched | **It is never used to serve production builds** — only to reproduce a historical result in an isolated environment |
| Beyond the retention window | The schedule version, its inputs, and its results remain; **the ability to re-derive them does not.** This limit is stated in the product, not discovered later |

---

## 5. Explanation — bounded tiers with honest failure

**The previous claim — "minimal infeasibility core" plus per-assignment "dominated alternative" rationales — is withdrawn as unbounded.** Both require potentially combinatorial counterfactual solves.

| Tier | Method | Budget | Guarantee |
|---|---|---|---|
| **T0 · Structural** | Static pre-solve checks: demand exceeding total eligible capacity; a shift type with no qualified member; a fixed assignment violating a hard rule; contradictory fixed assignments | Milliseconds | **Always attempted.** Exact when it fires |
| **T1 · Assumption-based** | Solve with relaxable-hard rule groups behind assumption literals; on infeasibility, extract the conflicting subset the solver reports | Bounded by one solve at the configured limit | **An infeasible subset**, not necessarily minimal |
| **T2 · Minimisation** | Iteratively shrink the T1 subset by re-solving | **Hard iteration and wall-clock cap** | **A locally minimal subset if the budget suffices** |
| **T3 · Alternatives** | For a *single* named assignment on explicit user request, bounded counterfactual solves | Per-request cap; never automatic; never for all assignments | Best effort, explicitly labelled |

**Degraded states are first-class outcomes, not silent failures:**

| State | Meaning shown to the scheduler |
|---|---|
| `EXPLAINED_EXACT` | T0 found the cause |
| `EXPLAINED_SUBSET` | A conflicting rule set, possibly not minimal |
| `EXPLAINED_MINIMAL` | Minimised within budget |
| **`EXPLANATION_BUDGET_EXCEEDED`** | **"Infeasible. The cause could not be isolated within the time budget."** Plus the partial subset and the T0 findings |
| **`EXPLANATION_UNAVAILABLE`** | Explanation itself failed. **Stated plainly** |

> **A scheduler is better served by "we could not isolate the cause in 60 seconds, here is what we do know" than by a system that appears to hang or invents a confident-sounding but wrong answer.**

**T1 depends on solver assumption support, which S-01 did not document.** That is recorded as an assumption to verify in benchmarking, not asserted ([SPEC-16](SPEC-16-sbx-evidence-contracts.md) SBX-031).

---

## 6. Candidate builds and comparison — D-4 replaced

**Old D-4:** at most one non-terminal build per period. **This prevented exactly the comparison CAP-017 and CAP-059 require.**

| New | Rule |
|---|---|
| **D-4a** | At most one non-terminal build **per `(period_id, build_configuration_id)`** — partial unique index. Prevents duplicate runs of the *same* configuration |
| **D-4b** | Multiple configurations may run concurrently for one period, bounded by a per-organization concurrency cap |
| **D-4c** | `build_runs.candidate_label` distinguishes candidates; comparison is a read-only projection over completed candidates |
| **D-4d** | **At most one build result may be applied to a given schedule version** — partial unique index on `(applied_to_version_id) WHERE applied_to_version_id IS NOT NULL` |

Progressive builds carry `parent_build_ids[]` and `protected_assignment_identities[]`, so a later build's fixed inputs are recorded rather than inferred.

---

## 7. Quality metrics and acceptance thresholds

| Metric | Definition | Threshold |
|---|---|---|
| `demand_satisfaction_rate` | Filled required slots ÷ total required | **Hard rule; a shortfall is a violation, not a metric** |
| `hard_violations` | Independent re-validation count (§3.3) | **Must be 0.** Non-zero fails the build |
| `soft_penalty_total` | Weighted objective value | Benchmark-relative; band per dataset class |
| `request_honour_rate` | Approved requests honoured ÷ total | Band per dataset class |
| `fairness_dispersion` | Coefficient of variation of normalised credits | Band per dataset class |
| `template_adherence_rate` | Template-conforming assignments ÷ applicable | Band per dataset class |
| `solve_wall_clock` | Seconds to terminal status | Per dataset class ([report 21](../../../schedulepoint-research/reports/21-automated-scheduling-production-requirements.md) §8.3) |
| `explanation_latency` | Seconds to an explanation state | Per tier budget |

**Bands are set from the benchmark corpus, not invented here.** Until the corpus is run, every band except `hard_violations = 0` is **undefined**, and saying so is the honest position. **PO-DEC-23 (solver performance targets) and PO-DEC-13 (conflict-severity taxonomy) remain pending.**

---

## 8. Benchmark corpus

Versioned, wholly synthetic, checked in as generator seeds plus a manifest — never as extracted data.

| Class | Shape | Exercises |
|---|---|---|
| `B-small` | 15 staff, 4 weeks, basic coverage | Smoke; runs in CI |
| `B-medium` | 60 staff, 8 weeks, patterns + requests | Everyday realism |
| `B-large` | 200 staff, 8 weeks, full rule set | Stated scale target |
| `B-multisite` | 120 staff, 3 locations | Location constraints |
| `B-ruleheavy` | 60 staff, every node type in §3.1 at least once | **Compiler coverage** |
| `B-progressive` | Multi-stage with protected assignments | CAP-017 |
| `B-infeasible-*` | One deliberately infeasible cause each: over-demand, missing qualification, fixed-assignment conflict, contradictory patterns | **Explanation oracle — the expected cause is known by construction** |
| `B-fte` | Weekday FTE and maximum-assignment boundaries | CAP-013 |
| `B-locum` | Staff-over-locum priority windows | CAP-025 |
| `B-fairness` | Known-skewed history | Fairness normalisation |

**`B-infeasible-*` is what makes explanation testable:** the dataset is generated *from* a known cause, so the explanation can be scored objectively instead of judged as "usable."

---

## 9. Test contract

| # | Test | Required outcome |
|---|---|---|
| S-01t | Every §3.1 node compiles | **Missing mapping fails CI** |
| S-02t | `HARD` never becomes an objective term | Property test over generated rule sets |
| S-03t | Independent re-validation of every returned solution | `hard_violations = 0` always |
| S-04t | Weekday FTE and max-assignment boundaries | Correct at, above, and below the limit |
| S-05t | Deadline honoured | Terminal status within limit + grace |
| S-06t | Mid-solve cancellation | Returns within grace; **subprocess kill proven to work** |
| S-07t | Wedged solve | Killed; state `failed`, reason `killed` |
| S-08t | Same everything → identical result | Bit-identical |
| S-09t | Different worker count → **no reproduction claim** | Test asserts the product does **not** claim reproduction here |
| S-10t | Protocol version outside window | **Rejected, not guessed** |
| S-11t | `B-infeasible-*` | Correct cause identified, or an explicit degraded state |
| S-12t | Explanation budget exhausted | **`EXPLANATION_BUDGET_EXCEEDED`, never a hang and never a fabricated cause** |
| S-13t | Concurrent candidates for one period | Both complete; comparison correct; D-4a holds |
| S-14t | Two results applied to one version | Second rejected by D-4d |
| S-15t | Solver worker attempts database access | **No credential exists; connection impossible** |
| S-16t | Per-organization concurrency cap | One tenant cannot starve another |

**Maps to SBX-015, SBX-016, SBX-017, SBX-030, SBX-031.**

---

## 10. Traceability

**Capabilities:** CAP-013, CAP-015, CAP-016, CAP-017, CAP-045, CAP-058, CAP-059, CAP-067.
**Decisions:** PO-DEC-05, PO-DEC-12, PO-DEC-13, PO-DEC-23 — **all pending.**
**ADRs:** [ADR-0002](../decisions/ADR-0002-primary-technology-stack.md) (revised), [ADR-0006](../decisions/ADR-0006-solver-architecture.md) (revised), **[ADR-0020](../decisions/ADR-0020-solver-runtime-packaging.md) (new)**.
**Gates:** `G-ARCH`, `G-PROD`. **None passed. No benchmark has been run.**
