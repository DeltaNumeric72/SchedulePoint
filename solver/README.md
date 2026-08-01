# `solver/` — scheduling worker (skeleton)

**There is no solver here.** This directory is a package skeleton: a
`pyproject.toml`, an importable package, and a `Dockerfile`. No OR-Tools code, no
model, no constraints.

## Why it exists before it does anything

Two reasons, both structural:

1. **The three-image topology is honoured from the first commit.** `Dockerfile.app`,
   `Dockerfile.ingress` and `solver/Dockerfile` exist together, so the boundary
   between the application and the second-language worker is a fact about the
   repository rather than a plan.
2. **The dependency list stays empty until the spike reports.** OR-Tools is not
   in `pyproject.toml`. SPEC-15's standing rule is that a gate closed without its
   spike is reopened; OPUS-M0-003 is that spike (CP-SAT boundary: serialize,
   solve, cancel, timeout, kill, restart, reproduce). Adding the dependency now
   would prejudge it.

## The constraints that already apply

| Rule                                                                                                             | Source        |
| ---------------------------------------------------------------------------------------------------------------- | ------------- |
| **No database access anywhere in the worker.** No credential, no client, no connection. Problem in, solution out | SPEC-04 §1    |
| **No CP-SAT type crosses the boundary.** `ortools` may be imported in exactly one adapter module                 | ADR-0006      |
| **One solve per subprocess.** Cancellation is layered: deadline → callback → SIGKILL                             | ADR-0020      |
| **Every run records seed, parameters, worker count and library versions**                                        | report 21 §7  |
| **Synthetic problems only.** No staff, patient, or customer data reaches the worker                              | CLAUDE.md §6a |

## Local use

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
python -m schedulepoint_solver   # exits non-zero: nothing is implemented
```

The entrypoint fails deliberately. A solver container that starts cleanly while
containing no solver is a worse outcome than one that refuses.
