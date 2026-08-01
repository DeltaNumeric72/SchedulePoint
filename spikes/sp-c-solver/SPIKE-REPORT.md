# SP-C / SP-5 — Solver boundary spike report

**Task:** OPUS-M0-003 · **Slice:** M0 / SP-C · **Engine plan stage:** E0
**Date:** 2026-08-01 · **Status of this document:** findings, for Fable review
**Evidence:** [`evidence/harness-output.txt`](evidence/harness-output.txt) (full captured run),
[`evidence/harness-results.json`](evidence/harness-results.json) (machine-readable),
[`evidence/environment.txt`](evidence/environment.txt),
[`evidence/probe-assumptions-extended.txt`](evidence/probe-assumptions-extended.txt)

---

## 0. What was asked and what came back

SP-5 asked whether the second-language boundary chosen in [ADR-0020](../../docs/architecture/decisions/ADR-0020-solver-runtime-packaging.md)
is cheap and controllable: serialise → solve → cancel → time out → kill → restart →
reproduce, on a toy problem, with determinism measured rather than assumed.

**It is controllable. It is cheap to cross. It is not automatically reproducible,
and that is the finding that matters.**

| # | Case | Outcome | The number that matters |
|---|---|---|---|
| H-0 | Static boundary guards | **PASS** | `ortools` imported in exactly 1 file of 12; no DB or network client anywhere in the worker |
| H-1 | Feasible solve, independently re-validated | **PASS** | OPTIMAL in 0.239 s; **0 hard violations**; independent objective 6048 == solver objective 6048 |
| H-2 | Over-constrained variants | **PASS** | spacing INFEASIBLE in 1.2 ms; **control instance OPTIMAL in 4.1 ms**; capacity INFEASIBLE in 18.6 ms |
| H-3 | Deadline (cancellation layer 1) | **PASS** | FEASIBLE at 5.018 s against a 5.0 s deadline — **18 ms overshoot**; bound 12000 < incumbent 18144 |
| H-4 | Cooperative cancel (layer 2) | **PASS** | control flag → `Solve()` returned in **113 ms**; cancel request → process exit **175 ms**, against a 30 s deadline never reached |
| H-5 | SIGKILL (layer 3) | **PASS** | exit signal 9, **no response written**, 0 survivors, 0 orphans, 0 temp files, reaped in **8.8 ms**; same problem re-solved immediately afterwards |
| H-6 | Determinism at fixed worker count | **PASS** (with a defect finding) | seed + 8 workers → **5 distinct schedules in 5 runs**. `interleave_search=True` → **1 in 5**. 1 worker → **1 in 5** |
| H-7 | Worker-count variance | **FINDING** | 1 / 4 / 8 workers → **3 distinct schedules**, all objective 6048 |
| H-8 | Assumption mechanism (T1) | **FINDING** | the mechanism exists and returns a **3-constraint minimal core**; enabling it turned an 18.6 ms INFEASIBLE proof into a **90 s UNKNOWN** on another instance |

Nine cases, zero failures. Two cases are recorded as FINDING because the packet
asked for a measurement, not a verdict fixed in advance.

---

## 1. Environment, and the FAD-7 substitution

| | |
|---|---|
| Host | macOS 26.5.2, arm64, 12 CPUs |
| Python | **CPython 3.9.6** — the system interpreter; FAD-7 forbids Homebrew, pyenv, and sudo |
| OR-Tools | **9.15.6755** (`ortools-9.15.6755-cp39-cp39-macosx_11_0_arm64.whl`), resolved and installed into a venv inside the spike directory |
| Transitive deps | absl-py 2.3.1, immutabledict 4.3.1, numpy 2.0.2, pandas 2.3.3, protobuf 6.33.6, python-dateutil 2.9.0.post0, pytz, six, typing_extensions, tzdata |
| Docker | **not available** |

### The substitution, stated plainly

The packet requires a solver Dockerfile. [`Dockerfile`](Dockerfile) is authored,
multi-stage, `python:3.12-slim-bookworm`, non-root (`solver`, uid 10001), and
**was not built** — there is no Docker daemon in the M0 environment.

The substitution is defensible for the specific properties SP-5 exists to prove.
Subprocess spawn, `SIGKILL`, orphan reaping, and the wait/exit-code contract are
POSIX process semantics: a `SIGKILL` to a PID inside a container terminates the
process exactly as it does outside one, and the reaping parent is the dispatch
process in both cases, not PID 1. Nothing measured in H-3, H-4, or H-5 depends
on a namespace.

What the substitution genuinely leaves unverified, and what CI must therefore
check on first build:

1. `ortools` resolves and imports on `linux/amd64` **and** `linux/arm64` slim — the
   wheel used here is macOS-specific.
2. The image size and, more importantly, the **cold-start cost of `import ortools`
   inside the image** (see §3 — it is the dominant per-solve cost, and §3 shows it
   is sensitive to the environment).
3. That the non-root user can run a solve with a read-only root filesystem.
4. That `ortools` 9.15 behaves identically on Python 3.12 — every number in this
   report was measured on 3.9.6.

**This is a gap, not a formality.** Item 4 in particular means the determinism
results in §4 must be re-run once the production interpreter is fixed.

### Python 3.9 is not acceptable for production

3.9 reached end of life in **October 2025**; it receives no security patches. It
was used here only because FAD-7 left no alternative on the host. The image pins
**3.12**, and re-running this harness under 3.12 is a prerequisite for closing
E0 rather than an optional extra.

---

## 2. What was built

A solver-neutral problem/solution schema and a Python worker that does exactly
one solve and exits.

```
SolveRequest { protocol_version, message_type, auth, context,
               solve_parameters, control, explanation, problem }
```

- **`protocol_version`** is checked against a bounded window and anything outside
  it is **rejected, not guessed at** (SPEC-04 §1.2).
- **`auth`** is the authenticated-call placeholder. Its shape is enforced and an
  unrecognised scheme is rejected with `unauthenticated`; **nothing is verified
  cryptographically**, and the response says so (`auth_echo.verified: false`).
  That is a deliberate, visible gap, not an oversight.
- **`context`** carries `organization_id` / `group_id` / `build_run_id` /
  `correlation_id`, echoed on every log line and in the response. Per SPEC-04
  §1.1 they are **labels for attribution, not authorization**, and the worker
  never branches on them.
- **`problem`** carries a typed, versioned rule list — `ELIGIBILITY`,
  `AT_MOST_ONE_ASSIGNMENT_PER_STAFF_PER_DAY`, `DEMAND_FULFILMENT`,
  `FORBIDDEN_SHIFT_SEQUENCE`, `MAX_ASSIGNMENTS_PER_STAFF` — plus a
  `FTE_TARGET_DEVIATION` soft objective. **No CP-SAT type appears anywhere in the
  schema.** An unmapped rule kind is rejected at validation, which is E1's
  "unmapped node fails CI" discipline applied a milestone early.

The toy instance is 20 staff × 14 days × 3 shift types, 168 demand units, 840
booleans. The hard instance used for the timing and cancellation cases is 60 ×
60 × 5, 17,160 booleans.

**Integer scaling is explicit.** No float enters the model. FTE is carried as
basis points and the per-staff target is
`round(total_required × fte_bp × 1000 / Σ fte_bp)` computed in integer
arithmetic, so the target is identical on every platform. The independent
re-validator re-derives the same formula from the problem document and the two
agreed exactly (objective 6048 both ways).

### The boundaries, and how they are enforced rather than asserted

| Claim | Enforcement | Evidence |
|---|---|---|
| No solver type leaks | only `worker/cpsat_adapter.py` imports `ortools` | H-0 scans all 12 Python files |
| The worker holds no DB credential | no driver is imported; no connection string exists in the protocol | H-0 scans for `psycopg`/`asyncpg`/`sqlalchemy`/`sqlite3`/… |
| No network egress | `socket.socket`, `socket.create_connection`, and `socket.getaddrinfo` are replaced with raising stubs **before the solve begins** | every response reports `egress_guard: installed`; no solve tripped it |
| The re-validator is independent | it re-implements every rule from the problem document and importing the adapter is a **H-0 failure** | H-0 |
| The committed instances match their generator | `problems/generate.py --check` | H-0 |

The egress guard is worth calling out: it converts "the worker does not need the
network" from a claim in a document into a property that fails loudly at
runtime.

---

## 3. Serialisation and boundary cost — the boundary is cheap, the process is not

Median of 5 runs on the toy problem, request 8,306 bytes in / 11,865 bytes out:

| Phase | Median |
|---|---|
| parent JSON encode | 0.1 ms |
| worker JSON parse + validate | 0.04 ms |
| worker JSON encode | 0.1 ms |
| parent JSON decode | 0.1 ms |
| **total serialisation, both directions** | **0.3 ms** |
| worker interpreter start + read + validate | 76 ms |
| **`import ortools`** | **631 ms** |
| model build (840 booleans) | 4.0 ms |
| solve | 185 ms |
| **total parent-observed wall** | **944 ms** |
| **per-solve process overhead** | **759 ms** |

**Serialisation is not the cost of the second language. Process start is.**
0.3 ms of JSON against 0.7 s of interpreter and library load, for a solve that
itself took 0.19 s. ADR-0020 listed "serialisation cost on every solve" as a
negative consequence; on this evidence that consequence is negligible and the
real one — one `import ortools` per solve — was not listed.

### A sharp edge found while measuring this

Handing the worker a **sanitised `HOME`** (an empty spike-owned directory, which
is the security-correct choice) makes `import ortools` take **631 ms**. With the
caller's real `HOME` the identical import takes **201 ms**, and interpreter
startup drops from 76 ms to 18 ms. The difference is **~430 ms per solve**, and
one solve is one process.

The cause is macOS per-user caching (dyld / code-signature validation state under
`~/Library/Caches`). It may well not reproduce on Linux — but the shape of the
problem will: *an aggressively minimal environment can cost more than the solve*.
CI must measure cold start inside the image, with the image's own `HOME`, before
anyone sizes the solver pool.

**Consequence for the pool design:** at ~0.75 s of fixed overhead per solve, the
one-solve-per-subprocess rule is affordable for a 60 s medium-group target
(report 21 §8.3) but not for anything interactive. If the platform ever wants
sub-second candidate comparison, the answer is a **pre-warmed pool of already-
imported worker processes that each accept exactly one solve and then exit** —
which preserves ADR-0020's kill guarantee while amortising the import. That is a
design note, not a change request.

---

## 4. Determinism — H-6 and H-7, stated plainly

Report 21 §7 makes reproducibility **absolute and non-configurable**: identical
inputs and seed must produce an identical schedule. This is the spike's most
consequential result.

### H-6: a fixed seed and a fixed worker count are NOT sufficient

Five consecutive runs, `random_seed=20260801`, `num_search_workers=8`, default
portfolio, toy problem solved to proven OPTIMAL every time:

| Configuration | Distinct solutions in 5 runs | Objective |
|---|---|---|
| 8 workers, default portfolio | **5 of 5 different** | 6048 every run |
| 8 workers, `interleave_search=True` | **1** (byte-identical) | 6048 |
| 1 worker | **1** (byte-identical) | 6048 |
| hard instance, 8 workers, **wall-clock** 5 s deadline | **5 of 5 different** | 18144 … 31608 |
| hard instance, 8 workers, `interleave_search=True` + `max_deterministic_time=2.0` | **1** (byte-identical) | 18144 |

Two independent causes, and they need different fixes:

1. **Parallel portfolio synchronisation.** CP-SAT's default parallel search lets
   workers exchange bounds and solutions whenever they happen to produce them,
   so the search path depends on thread timing. Same seed, same worker count,
   different schedule. Fixed by `interleave_search=True`, which runs the
   portfolio in deterministic batches, or by dropping to one worker.
2. **Wall-clock stopping.** A `max_time_in_seconds` limit makes the stopping
   *point* a property of the machine. Even with a deterministic portfolio, a
   wall-clock deadline reintroduces nondeterminism whenever it binds. Fixed by
   stopping on `max_deterministic_time` instead — which produced
   byte-identical schedules on five consecutive runs of the hard instance while
   wall time varied between 2.573 s and 2.615 s.

**Determinism is achievable and was achieved.** The escalation condition
("determinism unachievable even at fixed worker count") is **not** met. But the
naive configuration — seed pinned, worker count pinned, wall-clock deadline —
silently violates an absolute product requirement, and would have done so in
production.

**Cost of determinism, measured:** on the toy instance the default 8-worker
portfolio proved optimality in **0.18 s**; the deterministic 8-worker
configuration took **2.19 s**, and a single worker took **2.50 s**. That is a
**~12× slowdown** on this instance for the same objective value. On the hard
instance the interleaved configuration was *faster* at proving optimality (2.59 s
to OPTIMAL) than the default portfolio was at 20 s (still FEASIBLE, bound 12000).
One instance each way: the trade is real but its sign is instance-dependent and
must be measured on the E1 benchmark corpus, not guessed.

### H-7: worker count changes the answer

Same seed, `interleave_search=True` so each configuration is internally
reproducible:

| `num_search_workers` | Self-consistent over 2 runs | Branches | Wall | Solution |
|---|---|---|---|---|
| 1 | yes | 20,997 / 20,997 | 0.892 s | hash `b10ae92f…` |
| 4 | yes | 83,246 / 83,246 | 3.329 s | hash `710fec10…` |
| 8 | yes | 106,919 / 106,919 | 2.208 s | hash `137a6be2…` |

Three worker counts, three different schedules, **all objective 6048**. Quality
is unaffected; the schedule is not. With the default portfolio it is worse — 8
workers did not even reproduce itself (branches 1,568 vs 1,662 on two runs of
the same input).

**Consequence:** `num_search_workers` is part of the reproducibility record and
must be **pinned per build**, never inherited from the node's CPU count. A
solver pool that autosizes threads to the machine would make historical rebuilds
irreproducible on a differently-sized node — silently, with no error, and with
the objective value unchanged so no quality gate would catch it. So must
`interleave_search`, and so must the stopping criterion. Even 1 worker with and
without `interleave_search` produced different schedules (`b58475f2…` vs
`b10ae92f…`), so the record must carry the **whole parameter set**, not a chosen
subset of it.

The response's `reproducibility.parameter_set` already reads the effective
parameters **back out of the solver** rather than echoing what was requested,
which is the right shape for this.

---

## 5. Cancellation — all three layers demonstrated

| Layer | Mechanism | Measured |
|---|---|---|
| 1 | solver-native deadline | 5.0 s requested, returned at **5.018 s** (18 ms overshoot). Status FEASIBLE, `termination_reason='deadline'`, `deadline_reached=true`, best bound 12000 strictly below incumbent 18144 — **a timed-out run cannot be mistaken for a completed one** (SPEC-04 §2) |
| 2 | control flag + solver solution callback | worker observed the flag ≤10 ms after it was set (poll interval); `Solve()` returned **113 ms** later; cancel request → process exit **175 ms**. A 30 s deadline was never approached |
| 2′ | watcher thread calling `CpSolver.StopSearch()` | `Solve()` returned **16.6 ms** after the flag was observed; request → exit **88 ms** |
| 3 | `SIGKILL` | returncode −9, **zero bytes on stdout**, parent reaped in **8.8 ms** |

All partial schedules returned by a cancelled solve passed the independent
re-validator with **zero hard violations** — a cancelled build returns a
truncated-but-valid schedule, not a corrupt one.

### The negative result: do not build cancellation on POSIX signals

`SIGUSR1` was tested as a third control channel. **It does not work.** Python
runs signal handlers only on the main thread and only when that thread is
executing bytecode; during a blocking native `Solve()` it is not. CP-SAT invoked
the Python solution callback **43 times** during the solve — all on worker
threads — and the handler still did not run. The flag was finally observed at
**30.03 s**, i.e. *after* the solve had already ended on its own deadline. The
worker then honestly reported `user_cancelled`, which is the correct behaviour
and also exactly how this bug would hide in production: the status is right, the
latency is 28 s instead of 0.2 s.

**Recommendation:** layer 2 is a control-channel flag observed by the solution
callback (measured 113 ms) or, better, by a watcher thread calling
`StopSearch()` (measured 17 ms, and independent of whether the search is
currently producing improving solutions). The callback path's latency is bounded
by the interval between improving solutions, which on a hard instance late in a
search can be long. **The watcher-thread path should be preferred**, with the
callback check retained as a second line.

Layer 3 is what makes the guarantee. It cost 8.8 ms, produced no orphan or
zombie process (`ps -Ao pid,ppid,stat,command` matched nothing), left no file in
the worker's `TMPDIR`, and the same problem re-solved cleanly immediately
afterwards.

---

## 6. H-8 — the assumption mechanism the T1 explanation tier needs

ADR-0020 records this as unverified: *"Whether CP-SAT exposes the assumption
mechanism the T1 explanation tier needs is unverified — S-01 did not document
it."*

**It is verified now, and the answer has two halves.**

### The mechanism exists and produces a genuinely minimal core

`CpModel.AddAssumption()` and `CpSolver.SufficientAssumptionsForInfeasibility()`
are both present in ortools 9.15.6755's Python API. Reifying each hard-rule
instance behind an assumption literal and solving the alternating-saturation
instance returned, out of **582** assumption literals, a core of **three**:

```
HR-DEMAND:d0:night          -- day 0 requires all 20 staff on night
HR-DEMAND:d1:day            -- day 1 requires all 20 staff on day
HR-SPACING:S01:d0:night>day -- S01 may not work night then day
```

That is not merely *sufficient*, it is **minimal and human-readable**: those three
constraints alone are contradictory, and the sentence a scheduler needs
("day 0 needs everyone on nights, day 1 needs everyone on days, and nobody may
do both") falls straight out of it. Reifying only the spacing rule narrowed the
core further, to the **single** literal `HR-SPACING:S01:d0:night>day`, in 2.6 ms.
Coarse per-rule granularity returned `{HR-DEMAND, HR-SPACING}` — cheaper, and a
weaker explanation. **The granularity knob is real and it works.**

### It is not free, and on some infeasibilities it does not return at all

| Instance | No assumptions | With assumptions |
|---|---|---|
| spacing (contradiction between two rules) | INFEASIBLE in **1.2 ms** | INFEASIBLE in **13.3 ms**, core of 3 |
| capacity (pigeonhole: 20×8 = 160 < 168) | INFEASIBLE in **18.6 ms** | **UNKNOWN at 20 s** — and still **UNKNOWN at 90 s**, at both granularities |

Reifying a constraint behind an enforcement literal removes it from the
arithmetic presolve can do. The capacity instance is infeasible by a one-line
counting argument that presolve finds instantly; behind assumption literals,
CP-SAT has to *search* for it, and does not finish. Restricting reification to
the single capacity rule did not help.

### What this means for the T1 tier

1. **T1 is buildable.** The core is real, small, and expressible in scheduler
   language.
2. **T1 must be a separate, budgeted, second solve** on a model already known to
   be infeasible. It must never be the *first* solve — that would turn a 19 ms
   "this is impossible" into a 90 s "I don't know".
3. **T1 must be allowed to fail** and the product must degrade gracefully to a
   coarser explanation. The conflict taxonomy needs a "no core available within
   budget" outcome; `B-infeasible-*` oracle fixtures in the E1 corpus must
   include at least one counting-infeasibility case so this failure mode is
   exercised on purpose rather than discovered in beta.
4. **Reify selectively.** Reifying only the rule classes that plausibly explain a
   conflict was measurably cheaper (2.6 ms vs 13.3 ms) and gave a *smaller* core.
   Rule-instance granularity should be a per-request parameter, which the spike's
   `explanation.assumption_granularity` / `assumption_rule_ids` fields already
   model.

---

## 7. Sharp edges

1. **`SIGUSR1` cannot cancel a native solve** (§5). The failure is silent and
   looks like success.
2. **Wall-clock deadlines destroy reproducibility** (§4). Nothing warns you; the
   objective value is often unchanged.
3. **A sanitised environment can cost more than the solve** (§3): ~430 ms per
   process from `HOME` alone on macOS.
4. **`SatParameters` defaults are not JSON-serialisable.** `max_deterministic_time`
   defaults to `+inf`; naively echoing the parameter set into a JSON
   reproducibility record raises `ValueError: Out of range float values are not
   JSON compliant`. The adapter maps non-finite values to `null`. Anything that
   persists a parameter set will hit this.
5. **`num_search_workers` vs `num_workers`.** Both exist on `SatParameters` and
   the response records both. Do not assume they are interchangeable in a
   reproducibility record.
6. **`AddAtMostOne` cannot carry an enforcement literal**, so assumption mode has
   to re-express those constraints as linear inequalities. The model is therefore
   *not the same model* in assumption mode — another reason T1 must be a separate
   solve rather than a flag on the production one.
7. **Every number here is from Python 3.9.6 on macOS/arm64.** The production
   image is 3.12 on Linux. Treat this report as a set of shapes and mechanisms,
   not as a performance baseline.

---

## 8. Recommendation — TDG-11 (solver aspects)

**Confirm the runtime decision. Reopen the reproducibility clause.**

**Confirmed by evidence, no change needed:**

- Python + OR-Tools CP-SAT over a versioned RPC boundary works, and the boundary
  is cheap to cross (0.3 ms of serialisation for the toy problem).
- One solve per subprocess is affordable (~0.75 s fixed overhead) and delivers
  exactly what ADR-0020 claims: `SIGKILL` ended a wedged solve in 8.8 ms with no
  orphan, no zombie, no temp file, and an immediate clean re-run.
- Three-layer cancellation works, with measured latencies of 18 ms (deadline
  overshoot), 113 ms (callback) / 17 ms (watcher thread), and 8.8 ms (kill).
- Solver-neutrality is enforceable statically and was enforced.
- INFEASIBLE is reported correctly and quickly, and the control instance proves
  the infeasibility is a property of the model.
- The T1 assumption mechanism **exists** — ADR-0020's open question is answered
  yes, with the caveats in §6.

**Requires a decision before E1/E2 (these are the reopen items):**

| # | Item | Why |
|---|---|---|
| R-1 | **Solver parameters must be a pinned, recorded set, not just a seed.** `num_search_workers`, `interleave_search`, and the stopping criterion all change the schedule. | Report 21 §7 makes reproducibility absolute; the naive configuration violates it silently |
| R-2 | **Adopt `interleave_search=True` (or 1 worker) for any build whose result must be reproducible**, and measure the cost on the E1 corpus before choosing. | Measured 11× slower on the toy instance, *faster* on the hard one. One instance each way is not a basis for a default |
| R-3 | **Stop on deterministic time, not wall-clock time, for reproducible builds** — with a wall-clock limit retained purely as a safety net. | A binding wall-clock deadline reintroduces nondeterminism even with a deterministic portfolio |
| R-4 | **T1 explanations are a separate budgeted solve that is permitted to fail.** | 18.6 ms → >90 s UNKNOWN on a counting infeasibility |
| R-5 | **Production image pins Python 3.12; re-run this harness under it before E0 is closed.** | 3.9 is EOL; every number here is from 3.9 |
| R-6 | **Build the image in CI and re-measure cold start inside it.** | The dominant per-solve cost is `import ortools`, and it is environment-sensitive |
| R-7 | **Prefer a watcher thread calling `StopSearch()` over the solution-callback check**, and never use POSIX signals as the cancellation channel. | 17 ms vs 113 ms, and the callback path's latency is bounded by the gap between improving solutions |

None of the escalation conditions was met: OR-Tools installed on Python 3.9,
INFEASIBLE was produced and detected in milliseconds, determinism was achieved at
a fixed worker count once the portfolio was made deterministic, and `SIGKILL`
left no orphan state.

**Not answered by this spike, and not claimed:** anything about performance or
quality at real scale. The hard instance here exists to be slow, not to be
representative. Report 21 §8.3's targets remain untested and the benchmark bands
stay undefined until the E1 corpus runs, exactly as the engine plan requires.
