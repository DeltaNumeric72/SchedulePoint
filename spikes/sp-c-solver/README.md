# SP-C — Solver boundary spike (SP-5)

Throwaway spike code for **OPUS-M0-003**. It exists to answer questions about the
Python/OR-Tools boundary before M4 depends on it, not to become the solver.
**Nothing here is production code and nothing here should be promoted as-is.**

Findings and recommendations: [SPIKE-REPORT.md](SPIKE-REPORT.md).
Captured run: [evidence/harness-output.txt](evidence/harness-output.txt).

## Layout

```
worker/                 the solver worker — one solve per process, stdio transport
  protocol.py           versioned envelope, validation, canonical JSON. NO solver types
  cpsat_adapter.py      THE ONLY FILE THAT IMPORTS ortools
  cancellation.py       cancellation layer 2: control channel -> flag
  egress_guard.py       replaces socket constructors with raising stubs during a solve
  main.py               entrypoint: one request in, one response out, exit
problems/
  generate.py           deterministic instance generator (`--check` verifies no drift)
  *.json                the committed instances
harness/
  driver.py             spawns one worker subprocess per request; kill/cancel actions
  validator.py          INDEPENDENT re-validator — re-implements the rules, no solver
  run_harness.py        cases H-0 .. H-8
  probe_assumption_budget.py   H-8 follow-up (90s budget); not in the standard run
evidence/               captured output
Dockerfile              authored, NOT built here (no Docker under FAD-7)
```

## Running it

```sh
cd spikes/sp-c-solver
python3 -m venv .venv                  # system python3 is 3.9.6 under FAD-7
.venv/bin/pip install -r requirements.txt
.venv/bin/python problems/generate.py  # regenerate instances (optional)
.venv/bin/python harness/run_harness.py
.venv/bin/python harness/run_harness.py --only H-6      # one case
```

Full run takes about four minutes and exits non-zero if any case fails. Cases
marked FINDING report a measurement rather than a pass/fail judgement.

A single solve, by hand:

```sh
.venv/bin/python - <<'PY' > /tmp/req.json
import sys, json; sys.path.insert(0, '.')
from harness import driver
print(json.dumps(driver.build_request(driver.load_problem('toy-feasible'))))
PY
.venv/bin/python -m worker.main < /tmp/req.json > /tmp/resp.json
.venv/bin/python harness/validator.py problems/toy-feasible.json /tmp/resp.json
```

## The boundaries this spike is asserting

| Boundary | How it is enforced here | Checked by |
|---|---|---|
| No solver type escapes the adapter | only `worker/cpsat_adapter.py` imports `ortools` | H-0, statically |
| Worker holds no DB credential | no driver imported, no connection string in the request | H-0, statically |
| No network egress | socket constructors replaced with raising stubs before the solve | `egress_guard`, reported in each response |
| One solve per process | the entrypoint answers once and exits | H-5 (SIGKILL leaves nothing behind) |
| Cancellation is a guarantee | deadline, then control-channel + callback, then SIGKILL | H-3, H-4, H-5 |
| The solution is checked by something that is not the solver | `harness/validator.py` re-implements every rule | H-1, H-2, H-3, H-4, H-5 |
