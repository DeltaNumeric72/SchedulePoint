# `solver/` — the scheduling worker

**M4-001 ships the boundary and a stub solve.** The RPC envelope, the mutual
authentication, the one-solve-per-subprocess lifetime, the layered cancellation,
the egress guard and the reproducibility record are all real. The *model* is a
deterministic greedy fill that makes no claim it cannot support. **M4-002
replaces `stub_solver.py` with the CP-SAT adapter and nothing else here moves.**

That ordering is doc 35 §6a's and it is the right way round: the expensive,
subtle, security-relevant parts of a second-language boundary are the boundary —
does the request authenticate, is the protocol version enforced, does a cancel
actually stop the solve, does a wedged process die, is a killed run reported as
killed. None of those needs a constraint model, and every one of them is harder
to test once a constraint model is in the way.

## Layout

| File | What it is |
| --- | --- |
| `protocol.py` | The versioned envelope, canonical JSON, structural validation, the outcome vocabulary. **No solver type appears in it** |
| `auth.py` | Mutual HMAC-SHA256 over a shared secret — SPEC-04 §1.1's "mutual authentication on the internal channel" |
| `cancellation.py` | The watcher-thread cancel channel. **Signals are prohibited** and a test scans for them |
| `egress_guard.py` | Sockets replaced with raising stubs; a resident database driver is a refusal |
| `runtime.py` | SPEC-04 §4's reproducibility record, with the mode **computed** from the parameters |
| `stub_solver.py` | The stub. Three behaviours, each one there so a boundary property can be exercised |
| `__main__.py` | One request in, one response out, then exit |

## The constraints that govern every line here

| Rule | Source |
| --- | --- |
| **No database access, ever.** No credential, no client, no connection. Problem in, solution out | SPEC-04 §1.1, S-15t |
| **No solver type crosses the boundary.** `ortools` may be imported in exactly one adapter module | ADR-0006 |
| **One solve per subprocess.** Cancellation is layered: deadline → watcher-thread stop → termination | ADR-0020, SPEC-04 §2 |
| **Cancellation is never a signal.** Measured: 28 s latency and a misreported outcome | EV-M0-SPC H-4, FAD-10 |
| **Every run records seed, parameters, worker count, library and image versions** — and reproducibility is *computed*, not declared | report 21 §7, SPEC-04 §4 as amended |
| **Synthetic problems only.** No staff, patient or customer data reaches the worker | CLAUDE.md §7 |

## Running it

The image is authored at the repository root as **`Dockerfile.solver`**, beside
`Dockerfile.app` and `Dockerfile.ingress`, so the three-image topology
(SPEC-10 §2) is visible in one listing. It pins Python 3.12 and OR-Tools at the
FAD-10 versions. **It is not built on this machine** — FAD-7: no Docker daemon —
and building it plus recording its digest is the standing CI condition.

Local execution is the FAD-7 substitution: the module runs from the source tree
on the host interpreter, and installs nothing.

```bash
# One solve. Reads a SolveRequest on stdin, writes a SolveResponse on stdout.
SP_SOLVER_RPC_SECRET=<32+ bytes> SP_SOLVER_RPC_KEY_ID=<key id> \
  python3 -m schedulepoint_solver < request.json
```

There is **no default secret**. A worker that cannot find one refuses every
request rather than accepting everything — the same fail-closed direction the
provider boundary takes when its probe is missing.

The authoritative proofs are on the platform side, in `apps/api/test/solver/`,
because they exercise the real subprocess across the real boundary: the round
trip, the auth refusals, the measured timeout kill, honest mid-solve
cancellation, the orphan check, and the malformed/oversized response refusals.
