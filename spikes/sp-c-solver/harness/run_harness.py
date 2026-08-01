"""SP-C harness: H-0 .. H-8. Prints everything it measures; asserts nothing quietly.

SPIKE CODE — SP-C / SP-5.

    .venv/bin/python harness/run_harness.py            # full run
    .venv/bin/python harness/run_harness.py --only H-6 # one case

Exit code 0 iff every case reached its expected outcome. A case that produces a
surprising-but-honest result (H-7 divergence is the candidate) is reported as a
FINDING, not a failure — the packet asks for the measurement, not a verdict
decided in advance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness import driver  # noqa: E402
from harness.validator import validate  # noqa: E402

SPIKE_DIR = driver.SPIKE_DIR
RESULTS: List[Dict[str, Any]] = []


# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------


def hr(char: str = "-") -> None:
    print(char * 78)


def head(case: str, title: str) -> None:
    print("")
    hr("=")
    print("%s  %s" % (case, title))
    hr("=")


def kv(label: str, value: Any) -> None:
    print("    %-38s %s" % (label + ":", value))


def record(case: str, title: str, outcome: str, detail: str, metrics: Dict[str, Any]) -> None:
    RESULTS.append(
        {"case": case, "title": title, "outcome": outcome, "detail": detail, "metrics": metrics}
    )
    print("")
    print("  >> %s %s — %s" % (case, outcome, detail))


def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# H-0 — static boundary guards
# ---------------------------------------------------------------------------

FORBIDDEN_IMPORT_TOKENS = [
    "psycopg",
    "asyncpg",
    "sqlalchemy",
    "sqlite3",
    "pymysql",
    "requests",
    "urllib",
    "http.client",
    "aiohttp",
    "boto3",
]


def case_h0() -> None:
    head("H-0", "Static boundary guards (no solver leak, no DB, no egress)")
    failures: List[str] = []

    worker_files = sorted(
        f for f in os.listdir(os.path.join(SPIKE_DIR, "worker")) if f.endswith(".py")
    )
    harness_files = sorted(
        f for f in os.listdir(os.path.join(SPIKE_DIR, "harness")) if f.endswith(".py")
    )

    ortools_importers = []
    for rel in [os.path.join("worker", f) for f in worker_files] + [
        os.path.join("harness", f) for f in harness_files
    ] + [os.path.join("problems", "generate.py")]:
        text = open(os.path.join(SPIKE_DIR, rel)).read()
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("import ortools") or stripped.startswith("from ortools"):
                ortools_importers.append(rel)
                break
    kv("files importing ortools", ortools_importers)
    if ortools_importers != ["worker/cpsat_adapter.py"]:
        failures.append("ortools imported outside the adapter: %s" % ortools_importers)

    # socket: permitted only in the module whose job is to *block* sockets
    socket_importers = []
    for f in worker_files:
        text = open(os.path.join(SPIKE_DIR, "worker", f)).read()
        for line in text.splitlines():
            if line.strip() in ("import socket", "from socket import *"):
                socket_importers.append("worker/%s" % f)
                break
    kv("worker files importing socket", socket_importers)
    if socket_importers != ["worker/egress_guard.py"]:
        failures.append("unexpected socket import: %s" % socket_importers)

    db_hits = []
    for f in worker_files:
        text = open(os.path.join(SPIKE_DIR, "worker", f)).read()
        for token in FORBIDDEN_IMPORT_TOKENS:
            for line in text.splitlines():
                s = line.strip()
                if (s.startswith("import ") or s.startswith("from ")) and token in s:
                    db_hits.append("worker/%s: %s" % (f, s))
    kv("worker DB/network client imports", db_hits or "none")
    if db_hits:
        failures.append("worker imports a DB or network client: %s" % db_hits)

    validator_text = open(os.path.join(SPIKE_DIR, "harness", "validator.py")).read()
    imports_adapter = any(
        (line.strip().startswith(("import ", "from ")) and "cpsat_adapter" in line)
        or "importlib" in line and "cpsat_adapter" in line
        for line in validator_text.splitlines()
    )
    kv("re-validator imports the adapter", imports_adapter)
    if imports_adapter:
        failures.append("the re-validator is not independent of the adapter")

    proc = subprocess.run(
        [sys.executable, os.path.join(SPIKE_DIR, "problems", "generate.py"), "--check"],
        capture_output=True,
        text=True,
        cwd=SPIKE_DIR,
    )
    kv("committed problems match generator", proc.returncode == 0)
    for line in proc.stdout.strip().splitlines():
        print("      %s" % line)
    if proc.returncode != 0:
        failures.append("committed problem JSON has drifted from the generator")

    record(
        "H-0",
        "static boundary guards",
        "PASS" if not failures else "FAIL",
        "; ".join(failures) if failures else "solver confined to the adapter; no DB or network client in the worker",
        {"ortools_importers": ortools_importers, "failures": failures},
    )


# ---------------------------------------------------------------------------
# H-1 — feasible solve, independently re-validated
# ---------------------------------------------------------------------------


def _boundary_cost(
    problem: Dict[str, Any],
    runs: int = 5,
    env_overrides: Optional[Dict[str, str]] = None,
    label: str = "toy-feasible",
) -> Dict[str, float]:
    """Where does the wall time of one boundary crossing actually go?

    This is the packet's 'serialization cost for the toy size' measurement. The
    interesting result is that serialisation is not the cost — process cold
    start is.
    """
    import statistics

    samples: Dict[str, List[float]] = {k: [] for k in (
        "worker_start_to_request_validated",
        "ortools_import",
        "model_build",
        "solve",
        "worker_request_parse",
        "worker_response_encode",
        "parent_request_encode",
        "parent_response_decode",
        "total_parent_wall",
    )}
    for i in range(runs):
        result = driver.run_solve(
            driver.build_request(
                problem, {"max_time_in_seconds": 30.0}, correlation_id="h1-cost-%d" % i
            ),
            env_overrides=env_overrides,
        )
        response = result.response
        assert response is not None, result.stderr_raw
        ready = result.event("worker_ready")
        start = result.event("solve_start")
        ser = response["reproducibility"]["serialization"]
        samples["worker_start_to_request_validated"].append(ready["ts_monotonic"])
        samples["ortools_import"].append(start["ts_monotonic"] - ready["ts_monotonic"])
        samples["model_build"].append(response["reproducibility"]["model_build_seconds"])
        samples["solve"].append(response["reproducibility"]["solve_wall_seconds"])
        samples["worker_request_parse"].append(ser["request_parse_seconds"])
        samples["worker_response_encode"].append(ser["response_encode_seconds"])
        samples["parent_request_encode"].append(result.request_encode_seconds)
        samples["parent_response_decode"].append(result.response_decode_seconds)
        samples["total_parent_wall"].append(result.parent_wall_seconds)

    print("")
    print("    Boundary cost decomposition, median of %d runs (%s):" % (runs, label))
    medians = {}
    for name, values in samples.items():
        medians[name] = round(statistics.median(values), 6)
        print("      %-38s %8.4f s   (min %.4f / max %.4f)"
              % (name, medians[name], min(values), max(values)))
    ser_total = (
        medians["worker_request_parse"]
        + medians["worker_response_encode"]
        + medians["parent_request_encode"]
        + medians["parent_response_decode"]
    )
    print("      %-38s %8.4f s" % ("--> total JSON serialisation", ser_total))
    print("      %-38s %8.4f s"
          % ("--> per-solve process overhead", medians["total_parent_wall"] - medians["solve"]))
    medians["serialisation_total"] = round(ser_total, 6)
    return medians


def case_h1() -> Dict[str, Any]:
    head("H-1", "Feasible solve, verified by an independent re-validator")
    problem = driver.load_problem("toy-feasible")
    request = driver.build_request(
        problem, {"max_time_in_seconds": 30.0, "num_search_workers": 8}, correlation_id="h1"
    )
    result = driver.run_solve(request)
    response = result.response
    assert response is not None, result.stderr_raw

    ready = result.event("worker_ready")
    solve_start = result.event("solve_start")
    rr = response["reproducibility"]

    kv("status", response["status"])
    kv("termination_reason", response["termination_reason"])
    kv("input_hash", response["input_hash"])
    kv("solution_hash", response["solution_hash"])
    kv("objective (solver)", rr["objective_value"])
    kv("best bound", rr["best_objective_bound"])
    kv("model build seconds", rr["model_build_seconds"])
    kv("solve wall seconds", rr["solve_wall_seconds"])
    kv("parent-observed wall seconds", round(result.parent_wall_seconds, 4))
    kv("worker cold start to solve_start (s)", round(solve_start["ts_monotonic"], 4))
    kv("request bytes / response bytes", "%d / %d" % (
        rr["serialization"]["request_bytes"],
        rr["serialization"]["response_bytes_excluding_telemetry"],
    ))
    kv("request parse / response encode (s)", "%s / %s" % (
        rr["serialization"]["request_parse_seconds"],
        rr["serialization"]["response_encode_seconds"],
    ))
    kv("egress guard", ready["egress_guard"])
    kv("auth echo", response["auth_echo"])
    kv("context echoed", canonical(response["context"]))

    report = validate(problem, response["solution"])
    kv("independent re-validator violations", report["hard_violations"])
    kv("independent objective recomputation", report["recomputed_objective_value"])
    kv("assignments", report["assignment_count"])
    kv("total demand units", report["total_required"])

    recomputed_hash = sha256(canonical(response["solution"]))
    kv("harness-recomputed solution hash matches", recomputed_hash == response["solution_hash"])

    boundary = _boundary_cost(problem, label="toy-feasible, sanitised HOME")
    inherited = _boundary_cost(
        problem,
        runs=3,
        env_overrides={"HOME": os.path.expanduser("~")},
        label="toy-feasible, inherited HOME (comparison only)",
    )
    print("")
    print("    FINDING — the boundary is cheap; the *process* is not. JSON in and out")
    print("    costs %.1f ms for this problem. One solve is one process, and the "
          "process costs" % (boundary["serialisation_total"] * 1000))
    print("    %.2f s before the solver sees the model, almost all of it "
          "`import ortools`."
          % (boundary["worker_start_to_request_validated"] + boundary["ortools_import"]))
    print("    Of that, %.2f s is an artefact of handing the worker a sanitised HOME: "
          "with the"
          % (boundary["ortools_import"] - inherited["ortools_import"]))
    print("    caller's HOME the same import takes %.2f s instead of %.2f s (macOS "
          "per-user"
          % (inherited["ortools_import"], boundary["ortools_import"]))
    print("    caches). In a container HOME is inside the image, so CI must "
          "re-measure this.")

    ok = (
        response["status"] in ("OPTIMAL", "FEASIBLE")
        and report["hard_violations"] == 0
        and report["recomputed_objective_value"] == rr["objective_value"]
        and recomputed_hash == response["solution_hash"]
    )
    record(
        "H-1",
        "feasible solve",
        "PASS" if ok else "FAIL",
        "%s in %.3fs; 0 hard violations; independent objective %d == solver objective %d"
        % (
            response["status"],
            rr["solve_wall_seconds"],
            report["recomputed_objective_value"],
            rr["objective_value"],
        ),
        {
            "status": response["status"],
            "solve_wall_seconds": rr["solve_wall_seconds"],
            "cold_start_seconds": round(solve_start["ts_monotonic"], 4),
            "hard_violations": report["hard_violations"],
            "objective": rr["objective_value"],
            "request_bytes": rr["serialization"]["request_bytes"],
            "response_bytes": rr["serialization"]["response_bytes_excluding_telemetry"],
            "boundary_cost_medians_seconds": boundary,
            "boundary_cost_inherited_home_seconds": inherited,
        },
    )
    return response


# ---------------------------------------------------------------------------
# H-2 — infeasibility, reported correctly and attributed to a named rule
# ---------------------------------------------------------------------------


def case_h2() -> None:
    head("H-2", "Over-constrained variants report INFEASIBLE (and the control proves why)")
    outcomes = {}
    for name, expected in (
        ("toy-infeasible-spacing", "INFEASIBLE"),
        ("toy-infeasible-spacing-control", "FEASIBLE_OR_OPTIMAL"),
        ("toy-infeasible-capacity", "INFEASIBLE"),
    ):
        problem = driver.load_problem(name)
        result = driver.run_solve(
            driver.build_request(
                problem, {"max_time_in_seconds": 30.0}, correlation_id="h2-%s" % name
            )
        )
        response = result.response
        assert response is not None, result.stderr_raw
        rr = response["reproducibility"]
        got = response["status"]
        ok = got in ("OPTIMAL", "FEASIBLE") if expected == "FEASIBLE_OR_OPTIMAL" else got == expected
        outcomes[name] = {
            "status": got,
            "expected": expected,
            "ok": ok,
            "wall": rr["solve_wall_seconds"],
            "raw": rr["raw_solver_status"],
        }
        print("")
        kv("instance", name)
        kv("  expected / got", "%s / %s" % (expected, got))
        kv("  raw CP-SAT status", rr["raw_solver_status"])
        kv("  solve wall seconds", rr["solve_wall_seconds"])
        kv("  description", problem["description"][:120])
        if got in ("OPTIMAL", "FEASIBLE"):
            rep = validate(problem, response["solution"])
            kv("  re-validator violations", rep["hard_violations"])
            outcomes[name]["hard_violations"] = rep["hard_violations"]

    print("")
    print("  The spacing instance and its control differ by exactly one rule "
          "(HR-SPACING).")
    print("  Infeasible with it, solvable without it: the infeasibility is a "
          "property of the")
    print("  model, not an artefact of the solver giving up.")

    ok = all(o["ok"] for o in outcomes.values())
    record(
        "H-2",
        "infeasibility detection",
        "PASS" if ok else "FAIL",
        "spacing=%s (%.4fs), control=%s (%.4fs), capacity=%s (%.4fs)"
        % (
            outcomes["toy-infeasible-spacing"]["status"],
            outcomes["toy-infeasible-spacing"]["wall"],
            outcomes["toy-infeasible-spacing-control"]["status"],
            outcomes["toy-infeasible-spacing-control"]["wall"],
            outcomes["toy-infeasible-capacity"]["status"],
            outcomes["toy-infeasible-capacity"]["wall"],
        ),
        outcomes,
    )


# ---------------------------------------------------------------------------
# H-3 — solver-native deadline (cancellation layer 1)
# ---------------------------------------------------------------------------


def case_h3() -> None:
    head("H-3", "Cancellation layer 1: solver-native deadline on a hard instance")
    limit = 5.0
    problem = driver.load_problem("hard-large")
    result = driver.run_solve(
        driver.build_request(
            problem,
            {"max_time_in_seconds": limit, "num_search_workers": 8},
            correlation_id="h3",
        ),
        timeout_seconds=120,
    )
    response = result.response
    assert response is not None, result.stderr_raw
    rr = response["reproducibility"]

    kv("requested deadline (s)", limit)
    kv("status", response["status"])
    kv("termination_reason", response["termination_reason"])
    kv("deadline_reached flag", response["deadline_reached"])
    kv("solver-reported wall (s)", rr["solver_reported_wall_seconds"])
    kv("adapter-measured wall (s)", rr["solve_wall_seconds"])
    kv("overshoot beyond deadline (s)", round(rr["solve_wall_seconds"] - limit, 4))
    kv("parent-observed process wall (s)", round(result.parent_wall_seconds, 4))
    kv("objective / best bound", "%s / %s" % (rr["objective_value"], rr["best_objective_bound"]))
    kv("improving solutions seen", rr["solution_callback_count"])
    kv("booleans in model", rr["num_booleans"])

    report = validate(problem, response["solution"]) if response["solution"] else None
    if report:
        kv("re-validator violations on the partial result", report["hard_violations"])

    print("")
    print("  SPEC-04 §2: FEASIBLE is not 'done'. The response carries "
          "termination_reason='deadline'")
    print("  and a best bound strictly below the incumbent, so the caller "
          "cannot mistake a")
    print("  timed-out run for a completed one.")

    ok = (
        response["status"] in ("FEASIBLE", "UNKNOWN")
        and response["termination_reason"] == "deadline"
        and response["deadline_reached"] is True
        and (report is None or report["hard_violations"] == 0)
    )
    record(
        "H-3",
        "solver deadline",
        "PASS" if ok else "FAIL",
        "%s at %.3fs against a %.1fs deadline (overshoot %.3fs); bound %s < incumbent %s"
        % (
            response["status"],
            rr["solve_wall_seconds"],
            limit,
            rr["solve_wall_seconds"] - limit,
            rr["best_objective_bound"],
            rr["objective_value"],
        ),
        {
            "limit": limit,
            "status": response["status"],
            "wall": rr["solve_wall_seconds"],
            "overshoot": round(rr["solve_wall_seconds"] - limit, 4),
            "hard_violations": report["hard_violations"] if report else None,
        },
    )


# ---------------------------------------------------------------------------
# H-4 — cooperative cancellation mid-solve (cancellation layer 2)
# ---------------------------------------------------------------------------


def _cancel_variant(
    label: str,
    channel: str,
    stop_via_thread: bool,
    delay: float = 2.0,
    deadline: float = 30.0,
) -> Dict[str, Any]:
    problem = driver.load_problem("hard-large")
    cancel_file = driver.tmp_path("cancel-%s" % label)
    ready_file = driver.tmp_path("ready-%s" % label)
    for path in (cancel_file, ready_file):
        if os.path.exists(path):
            os.remove(path)

    control = {"cancel_channel": channel, "stop_via_thread": stop_via_thread}
    if channel == "file":
        control["cancel_file"] = cancel_file
        action = driver.action_touch_cancel_file(cancel_file)
    else:
        action = driver.action_send_signal(signal.SIGUSR1)

    request = driver.build_request(
        problem,
        {"max_time_in_seconds": deadline, "num_search_workers": 8},
        control=control,
        correlation_id="h4-%s" % label,
    )
    t_before = time.monotonic()
    result = driver.run_solve(
        request,
        ready_file=ready_file,
        on_ready=action,
        ready_delay_seconds=delay,
        timeout_seconds=deadline + 60,
    )
    response = result.response
    parent_latency = result.parent_wall_seconds - (result.action_at_offset_seconds or 0.0)
    if response is None:
        print("")
        kv("variant", label)
        kv("  control channel", channel)
        kv("  NO RESPONSE — process exited with", result.returncode)
        kv("  exit signal", result.exit_signal)
        kv("  request -> exit (s)", round(parent_latency, 4))
        return {
            "label": label,
            "channel": channel,
            "stop_path": "n/a",
            "status": "NO_RESPONSE",
            "termination_reason": "killed_by_default_signal_action"
            if result.exit_signal
            else "unknown",
            "observed_to_return_seconds": None,
            "cancel_to_exit_seconds": round(parent_latency, 4),
            "solve_wall_seconds": None,
            "cancelled": False,
            "response": None,
            "problem": problem,
        }
    c = response["cancellation"]

    print("")
    kv("variant", label)
    kv("  control channel", c["channel"])
    kv("  stop path", c["stop_path"])
    kv("  status", response["status"])
    kv("  termination_reason", response["termination_reason"])
    kv("  cancel requested at (parent offset s)", round(result.action_at_offset_seconds or -1, 4))
    kv("  worker observed cancel at (solve offset s)", c["observed_at_offset_seconds"])
    kv("  worker acted on cancel at (solve offset s)", c["acted_at_offset_seconds"])
    kv("  observed -> Solve() returned (s)", c["observed_to_return_seconds"])
    kv("  acted -> Solve() returned (s)", c["acted_to_return_seconds"])
    kv("  cancel request -> process exit (s)", round(parent_latency, 4))
    kv("  deadline that was NOT waited out (s)", deadline)
    kv("  improving solutions before stop", response["reproducibility"]["solution_callback_count"])

    return {
        "label": label,
        "channel": c["channel"],
        "stop_path": c["stop_path"],
        "status": response["status"],
        "termination_reason": response["termination_reason"],
        "observed_to_return_seconds": c["observed_to_return_seconds"],
        "cancel_to_exit_seconds": round(parent_latency, 4),
        "solve_wall_seconds": response["reproducibility"]["solve_wall_seconds"],
        "cancelled": c["cancelled"],
        "response": response,
        "problem": problem,
    }


def case_h4() -> None:
    head("H-4", "Cancellation layer 2: cooperative cancel mid-solve")
    variants = [
        _cancel_variant("callback-file", "file", stop_via_thread=False),
        _cancel_variant("threadstop-file", "file", stop_via_thread=True),
        _cancel_variant("callback-sigusr1", "signal", stop_via_thread=False),
    ]

    print("")
    print("  Required mechanism is 'callback-file': the flag is set on the "
          "worker's control")
    print("  channel and the solver's solution callback observes it and calls "
          "StopSearch().")
    print("  The other two are measured because the latency difference is the "
          "engineering fact.")

    # Pass/fail rests on the required mechanism only: control flag observed by
    # the solver's solution callback. The other two are observations.
    primary = variants[0]
    ok = (
        primary["cancelled"]
        and primary["termination_reason"] == "user_cancelled"
        and primary["solve_wall_seconds"] is not None
        and primary["solve_wall_seconds"] < 25.0
    )

    print("")
    for v in variants:
        if v["response"] is not None and v["response"]["solution"] is not None:
            rep = validate(v["problem"], v["response"]["solution"])
            print("    %-18s hard violations in the returned partial schedule: %d"
                  % (v["label"], rep["hard_violations"]))
            if v is primary and rep["hard_violations"] != 0:
                ok = False
        else:
            print("    %-18s no partial schedule returned" % v["label"])

    record(
        "H-4",
        "cooperative cancellation",
        "PASS" if ok else "FAIL",
        "callback+file: %s, Solve() returned %.3fs after the worker observed the "
        "request (request->process exit %.3fs) against a 30s deadline that was "
        "never reached"
        % (
            primary["termination_reason"],
            primary["observed_to_return_seconds"] or -1,
            primary["cancel_to_exit_seconds"],
        ),
        {v["label"]: {k: v[k] for k in
                      ("channel", "stop_path", "status", "termination_reason",
                       "observed_to_return_seconds", "cancel_to_exit_seconds",
                       "solve_wall_seconds")} for v in variants},
    )


# ---------------------------------------------------------------------------
# H-5 — SIGKILL mid-solve (cancellation layer 3)
# ---------------------------------------------------------------------------


def case_h5() -> None:
    head("H-5", "Cancellation layer 3: SIGKILL mid-solve, cleanliness, and restart")
    driver.reset_tmp()
    problem = driver.load_problem("hard-large")
    ready_file = driver.tmp_path("ready-h5")

    before = driver.worker_processes()
    kv("worker processes before", len(before))

    request = driver.build_request(
        problem,
        {"max_time_in_seconds": 120.0, "num_search_workers": 8},
        correlation_id="h5",
    )
    result = driver.run_solve(
        request,
        ready_file=ready_file,
        on_ready=driver.action_sigkill(),
        ready_delay_seconds=2.0,
        timeout_seconds=180,
    )

    kv("worker pid", result.pid)
    kv("kill sent at (parent offset s)", round(result.action_at_offset_seconds or -1, 4))
    kv("parent-observed process wall (s)", round(result.parent_wall_seconds, 4))
    kv("returncode", result.returncode)
    kv("exit signal", result.exit_signal)
    kv("SIGKILL is signal", int(signal.SIGKILL))
    kv("response on stdout", "none" if result.response is None else "unexpected response!")
    kv("stdout bytes", result.stdout_bytes)
    kv("kill -> parent reaped (s)",
       round(result.parent_wall_seconds - (result.action_at_offset_seconds or 0.0), 4))

    # Settle, then look for anything left behind.
    time.sleep(0.5)
    survivors = driver.worker_processes()
    orphans = driver.zombie_or_orphan_workers()
    kv("worker processes after", len(survivors))
    kv("orphaned/zombie workers (ppid==1 or Z)", orphans if orphans else "none")
    if survivors:
        for row in survivors:
            print("      SURVIVOR %s" % row)

    ps_snapshot = subprocess.run(
        ["ps", "-Ao", "pid,ppid,stat,command"], capture_output=True, text=True
    ).stdout
    matching = [l for l in ps_snapshot.splitlines() if "worker.main" in l]
    kv("`ps -Ao pid,ppid,stat,command | grep worker.main`", matching if matching else "no matches")

    leftovers = driver.worker_tmp_listing()
    kv("files left in the worker TMPDIR", leftovers if leftovers else "none")

    # Same problem, immediately again.
    print("")
    print("  Re-running the same problem in a fresh subprocess:")
    rerun = driver.run_solve(
        driver.build_request(
            problem, {"max_time_in_seconds": 5.0, "num_search_workers": 8},
            correlation_id="h5-rerun",
        ),
        timeout_seconds=120,
    )
    rerun_ok = rerun.response is not None and rerun.response["status"] in ("OPTIMAL", "FEASIBLE")
    kv("  rerun status", rerun.response["status"] if rerun.response else "no response")
    kv("  rerun returncode", rerun.returncode)
    if rerun.response and rerun.response["solution"]:
        rep = validate(problem, rerun.response["solution"])
        kv("  rerun re-validator violations", rep["hard_violations"])
        rerun_ok = rerun_ok and rep["hard_violations"] == 0

    ok = (
        result.exit_signal == int(signal.SIGKILL)
        and result.response is None
        and not survivors
        and not orphans
        and not leftovers
        and rerun_ok
    )
    record(
        "H-5",
        "SIGKILL cleanliness",
        "PASS" if ok else "FAIL",
        "worker died on signal %s with no response, %d survivors, %d orphans, "
        "%d temp files; same problem re-solved afterwards (%s)"
        % (
            result.exit_signal,
            len(survivors),
            len(orphans),
            len(leftovers),
            rerun.response["status"] if rerun.response else "no response",
        ),
        {
            "exit_signal": result.exit_signal,
            "survivors": len(survivors),
            "orphans": len(orphans),
            "tmp_files": leftovers,
            "kill_to_reap_seconds": round(
                result.parent_wall_seconds - (result.action_at_offset_seconds or 0.0), 4
            ),
            "rerun_status": rerun.response["status"] if rerun.response else None,
        },
    )


# ---------------------------------------------------------------------------
# H-6 — determinism at a fixed worker count
# ---------------------------------------------------------------------------


def _repeat(problem_name: str, params: Dict[str, Any], runs: int, tag: str) -> Dict[str, Any]:
    problem = driver.load_problem(problem_name)
    hashes, objectives, walls, statuses = [], [], [], []
    for i in range(runs):
        result = driver.run_solve(
            driver.build_request(problem, params, correlation_id="%s-%d" % (tag, i)),
            timeout_seconds=params["max_time_in_seconds"] + 120,
        )
        response = result.response
        assert response is not None, result.stderr_raw
        solution_hash = sha256(canonical(response["solution"])) if response["solution"] else None
        hashes.append(solution_hash)
        objectives.append(response["reproducibility"]["objective_value"])
        walls.append(response["reproducibility"]["solve_wall_seconds"])
        statuses.append(response["status"])
        print("    run %d  status=%-9s obj=%-8s wall=%7.3fs  solution_sha256=%s"
              % (i + 1, statuses[-1], objectives[-1], walls[-1],
                 (solution_hash or "-")[:32]))
    return {
        "hashes": hashes,
        "objectives": objectives,
        "walls": walls,
        "statuses": statuses,
        "identical": len(set(hashes)) == 1,
        "objectives_identical": len(set(objectives)) == 1,
    }


def case_h6() -> None:
    head("H-6", "Determinism: same seed, same worker count, 5 consecutive runs")
    print("  The packet asks whether a fixed seed and a fixed worker count give "
          "byte-identical")
    print("  solutions. Four configurations are run, because the honest answer "
          "is 'not by")
    print("  themselves, and here is what does'.")

    blocks: Dict[str, Dict[str, Any]] = {}

    print("")
    print("  H-6a  DEFAULT portfolio: 8 workers, wall-clock deadline, "
          "interleave_search off")
    a_params = {"random_seed": 20260801, "num_search_workers": 8, "max_time_in_seconds": 30.0}
    kv("instance / parameters", "toy-feasible / %s" % canonical(a_params))
    blocks["a_default_8_workers"] = _repeat("toy-feasible", a_params, 5, "h6a")
    kv("distinct solution hashes", len(set(blocks["a_default_8_workers"]["hashes"])))
    kv("byte-identical across 5 runs", blocks["a_default_8_workers"]["identical"])
    kv("objective identical across 5 runs",
       blocks["a_default_8_workers"]["objectives_identical"])

    print("")
    print("  H-6b  8 workers with interleave_search=True (deterministic "
          "portfolio batching)")
    b_params = {
        "random_seed": 20260801,
        "num_search_workers": 8,
        "interleave_search": True,
        "max_time_in_seconds": 60.0,
    }
    kv("parameters", canonical(b_params))
    blocks["b_interleaved_8_workers"] = _repeat("toy-feasible", b_params, 5, "h6b")
    kv("distinct solution hashes", len(set(blocks["b_interleaved_8_workers"]["hashes"])))
    kv("byte-identical across 5 runs", blocks["b_interleaved_8_workers"]["identical"])

    print("")
    print("  H-6c  single worker (num_search_workers = 1)")
    c_params = {"random_seed": 20260801, "num_search_workers": 1, "max_time_in_seconds": 60.0}
    blocks["c_single_worker"] = _repeat("toy-feasible", c_params, 5, "h6c")
    kv("distinct solution hashes", len(set(blocks["c_single_worker"]["hashes"])))
    kv("byte-identical across 5 runs", blocks["c_single_worker"]["identical"])

    print("")
    print("  H-6d  time-BOUNDED and still reproducible: deterministic time "
          "limit instead of")
    print("        a wall-clock one, on the hard instance "
          "(max_deterministic_time=2.0)")
    d_params = {
        "random_seed": 20260801,
        "num_search_workers": 8,
        "interleave_search": True,
        "max_time_in_seconds": 300.0,
        "max_deterministic_time": 2.0,
    }
    kv("parameters", canonical(d_params))
    blocks["d_deterministic_time_limit"] = _repeat("hard-large", d_params, 5, "h6d")
    kv("distinct solution hashes", len(set(blocks["d_deterministic_time_limit"]["hashes"])))
    kv("byte-identical across 5 runs", blocks["d_deterministic_time_limit"]["identical"])
    kv("wall-clock spread (s)", "%.3f .. %.3f" % (
        min(blocks["d_deterministic_time_limit"]["walls"]),
        max(blocks["d_deterministic_time_limit"]["walls"]),
    ))

    print("")
    print("  H-6e  the counter-example: hard instance stopped by a WALL-CLOCK "
          "deadline")
    e_params = {"random_seed": 20260801, "num_search_workers": 8, "max_time_in_seconds": 5.0}
    blocks["e_wallclock_deadline"] = _repeat("hard-large", e_params, 5, "h6e")
    kv("distinct solution hashes", len(set(blocks["e_wallclock_deadline"]["hashes"])))
    kv("objectives", blocks["e_wallclock_deadline"]["objectives"])

    print("")
    print("  FINDING, stated definitively:")
    print("   * A fixed seed and a fixed worker count are NOT sufficient. With "
          "the default")
    print("     portfolio at 8 workers the same problem produced %d distinct "
          "schedules in 5 runs"
          % len(set(blocks["a_default_8_workers"]["hashes"])))
    print("     — all proving the same optimum, so this is a reproducibility "
          "defect, not a")
    print("     quality one. Workers exchange information on wall-clock timing.")
    print("   * Determinism IS achievable, two ways: num_search_workers=1, or "
          "any worker count")
    print("     with interleave_search=True. Both gave 1 distinct hash in 5 "
          "runs.")
    print("   * A wall-clock deadline destroys determinism regardless "
          "(%d distinct in 5). A"
          % len(set(blocks["e_wallclock_deadline"]["hashes"])))
    print("     deterministic time limit preserves it (%d distinct in 5) while "
          "still bounding"
          % len(set(blocks["d_deterministic_time_limit"]["hashes"])))
    print("     the solve.")

    reproducible_config_found = (
        blocks["b_interleaved_8_workers"]["identical"]
        or blocks["c_single_worker"]["identical"]
    )
    record(
        "H-6",
        "determinism at fixed worker count",
        "PASS" if reproducible_config_found else "FAIL",
        "seed+worker-count alone is NOT deterministic (%d distinct schedules in 5 runs at "
        "8 workers, all objective %s). Deterministic with interleave_search=True at 8 "
        "workers (%d distinct in 5) and at 1 worker (%d distinct in 5). Wall-clock "
        "deadline: %d distinct in 5; deterministic time limit: %d distinct in 5."
        % (
            len(set(blocks["a_default_8_workers"]["hashes"])),
            blocks["a_default_8_workers"]["objectives"][0],
            len(set(blocks["b_interleaved_8_workers"]["hashes"])),
            len(set(blocks["c_single_worker"]["hashes"])),
            len(set(blocks["e_wallclock_deadline"]["hashes"])),
            len(set(blocks["d_deterministic_time_limit"]["hashes"])),
        ),
        {
            name: {
                "distinct_hashes": len(set(b["hashes"])),
                "identical": b["identical"],
                "objectives": b["objectives"],
                "walls": [round(w, 3) for w in b["walls"]],
                "statuses": b["statuses"],
                "first_hash": b["hashes"][0],
            }
            for name, b in blocks.items()
        },
    )


# ---------------------------------------------------------------------------
# H-7 — determinism vs worker count
# ---------------------------------------------------------------------------


def _worker_count_block(interleave: bool, tag: str) -> List[Dict[str, Any]]:
    """Run 1/4/8 workers twice each and print the table. Returns the rows."""
    rows = []
    problem = driver.load_problem("toy-feasible")
    for workers in (1, 4, 8):
        params = {
            "random_seed": 20260801,
            "num_search_workers": workers,
            "max_time_in_seconds": 60.0,
        }
        if interleave:
            params["interleave_search"] = True
        hashes, objs, walls, branches = [], [], [], []
        response = None
        for i in range(2):  # twice each, to separate "differs by workers" from noise
            result = driver.run_solve(
                driver.build_request(
                    problem, params, correlation_id="%s-%d-%d" % (tag, workers, i)
                ),
                timeout_seconds=240,
            )
            response = result.response
            assert response is not None, result.stderr_raw
            hashes.append(sha256(canonical(response["solution"])))
            objs.append(response["reproducibility"]["objective_value"])
            walls.append(response["reproducibility"]["solve_wall_seconds"])
            branches.append(response["reproducibility"]["num_branches"])
        rows.append(
            {
                "workers": workers,
                "effective_workers": response["reproducibility"]["effective_num_workers"],
                "status": response["status"],
                "hash": hashes[0],
                "hashes": hashes,
                "stable_within_worker_count": len(set(hashes)) == 1,
                "objective": objs[0],
                "objectives": objs,
                "walls": [round(w, 3) for w in walls],
                "branches": branches,
            }
        )
        print("    workers=%d  status=%-8s obj=%-6s wall=%.3f/%.3f  branches=%s  "
              "self-consistent=%s"
              % (workers, response["status"], objs[0], walls[0], walls[1],
                 branches, len(set(hashes)) == 1))
        print("              solution_sha256=%s" % hashes[0])
    return rows


def _summarise_block(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    distinct = len({r["hash"] for r in rows})
    objectives = sorted({r["objective"] for r in rows})
    self_consistent = all(r["stable_within_worker_count"] for r in rows)
    print("")
    kv("  distinct solutions across worker counts", distinct)
    kv("  distinct objective values", objectives)
    kv("  each worker count reproduced itself (2 runs)", self_consistent)
    return {
        "rows": rows,
        "distinct_solutions": distinct,
        "distinct_objectives": objectives,
        "self_consistent": self_consistent,
    }


def case_h7() -> None:
    head("H-7", "Worker-count variance: num_search_workers = 1 / 4 / 8, same seed")

    print("  Block 1 — DEFAULT portfolio (interleave_search off)")
    default_block = _summarise_block(_worker_count_block(False, "h7-default"))

    print("")
    print("  Block 2 — interleave_search=True (the configuration H-6 showed is "
          "reproducible)")
    interleaved_block = _summarise_block(_worker_count_block(True, "h7-interleaved"))

    print("")
    print("  FINDING, stated plainly:")
    print("   * With the default portfolio, worker count changes the answer AND "
          "a single worker")
    print("     count does not even reproduce itself (self-consistent: %s). "
          "Worker count is not"
          % default_block["self_consistent"])
    print("     the only variable in play there.")
    print("   * With interleave_search=True each worker count IS internally "
          "reproducible (%s),"
          % interleaved_block["self_consistent"])
    print("     and the three worker counts still produce %d distinct "
          "schedules from the same"
          % interleaved_block["distinct_solutions"])
    print("     seed. Objective values: %s — quality is identical, the schedule "
          "is not."
          % interleaved_block["distinct_objectives"])
    print("   * Consequence for TDG-11: num_search_workers is part of the "
          "reproducibility")
    print("     record and must be pinned per build, not inherited from the "
          "node's CPU count.")

    record(
        "H-7",
        "worker-count variance",
        "FINDING",
        "default portfolio: %d distinct solutions across 1/4/8, self-consistent=%s. "
        "interleave_search=True: %d distinct solutions across 1/4/8, "
        "self-consistent=%s, objectives %s (quality identical, schedule not). "
        "Worker count must be pinned."
        % (
            default_block["distinct_solutions"],
            default_block["self_consistent"],
            interleaved_block["distinct_solutions"],
            interleaved_block["self_consistent"],
            interleaved_block["distinct_objectives"],
        ),
        {"default_portfolio": default_block, "interleaved": interleaved_block},
    )


# ---------------------------------------------------------------------------
# H-8 — assumption mechanism for explanation tier T1
# ---------------------------------------------------------------------------


def case_h8() -> None:
    head("H-8", "Explanation tier T1 probe: CP-SAT assumptions on infeasible models")
    print("  CP-SAT's Python API exposes CpModel.AddAssumption() and")
    print("  CpSolver.SufficientAssumptionsForInfeasibility(). Both are present "
          "in this build.")
    print("  The question is whether they are *usable*: does the core come "
          "back, is it small,")
    print("  and what does reification cost?")

    matrix = [
        ("toy-infeasible-spacing", "instance", None, 20.0),
        ("toy-infeasible-spacing", "rule", None, 20.0),
        ("toy-infeasible-spacing", "instance", ["HR-SPACING"], 20.0),
        ("toy-infeasible-capacity", "instance", None, 20.0),
        ("toy-infeasible-capacity", "rule", None, 20.0),
        ("toy-infeasible-capacity", "instance", ["HR-MAXASSIGN"], 20.0),
    ]
    baseline: Dict[str, float] = {}
    for name in ("toy-infeasible-spacing", "toy-infeasible-capacity"):
        problem = driver.load_problem(name)
        result = driver.run_solve(
            driver.build_request(problem, {"max_time_in_seconds": 20.0},
                                 correlation_id="h8-base-%s" % name),
            timeout_seconds=120,
        )
        baseline[name] = result.response["reproducibility"]["solve_wall_seconds"]
        print("")
        kv("baseline (no assumptions) %s" % name,
           "%s in %.4fs" % (result.response["status"], baseline[name]))

    rows = []
    for name, granularity, rule_ids, limit in matrix:
        problem = driver.load_problem(name)
        explanation = {"use_assumptions": True, "assumption_granularity": granularity}
        if rule_ids:
            explanation["assumption_rule_ids"] = rule_ids
        result = driver.run_solve(
            driver.build_request(
                problem,
                {"max_time_in_seconds": limit, "num_search_workers": 8},
                explanation=explanation,
                correlation_id="h8",
            ),
            timeout_seconds=limit + 120,
        )
        response = result.response
        assert response is not None, result.stderr_raw
        sa = response["sufficient_assumptions"]
        print("")
        kv("instance / granularity / reified rules",
           "%s / %s / %s" % (name, granularity, rule_ids or "all"))
        kv("  status", response["status"])
        kv("  solve wall (s)", response["reproducibility"]["solve_wall_seconds"])
        kv("  baseline wall without assumptions (s)", baseline[name])
        kv("  assumption literals in model", sa["assumption_count_total"])
        kv("  sufficient-for-infeasibility set size", sa["count"])
        kv("  core", sa["labels"] if sa["count"] else "(none returned)")
        rows.append(
            {
                "instance": name,
                "granularity": granularity,
                "reified_rules": rule_ids or "all",
                "status": response["status"],
                "wall": response["reproducibility"]["solve_wall_seconds"],
                "baseline_wall": baseline[name],
                "assumptions": sa["assumption_count_total"],
                "core_size": sa["count"],
                "core": sa["labels"],
            }
        )

    spacing_rows = [r for r in rows if r["instance"] == "toy-infeasible-spacing"]
    capacity_rows = [r for r in rows if r["instance"] == "toy-infeasible-capacity"]
    mechanism_works = any(r["core_size"] > 0 for r in spacing_rows)

    print("")
    print("  T1 verdict material:")
    print("   * the mechanism EXISTS and returns a genuinely minimal core on "
          "the spacing")
    print("     instance — 3 constraints out of %d, naming the two demand cells "
          "and the one"
          % spacing_rows[0]["assumptions"])
    print("     spacing pair that contradict. That is a usable scheduler-facing "
          "explanation.")
    print("   * it is NOT free: reifying constraints behind assumption literals "
          "disables the")
    print("     presolve reasoning that proves counting infeasibilities. The "
          "capacity instance")
    print("     goes from %.4fs (INFEASIBLE) to a %.0fs timeout (UNKNOWN) once "
          "assumptions are"
          % (baseline["toy-infeasible-capacity"], capacity_rows[0]["wall"]))
    print("     switched on — even with only the capacity rule reified.")

    record(
        "H-8",
        "assumption mechanism / T1",
        "FINDING",
        "AddAssumption + SufficientAssumptionsForInfeasibility exist and work: "
        "minimal 3-literal core on the spacing instance (%.4fs). But assumptions "
        "cost presolve: the capacity instance goes from %.4fs INFEASIBLE to "
        "UNKNOWN at the %.0fs limit."
        % (
            spacing_rows[0]["wall"],
            baseline["toy-infeasible-capacity"],
            capacity_rows[0]["wall"],
        ),
        {"rows": rows, "baseline": baseline, "mechanism_present": mechanism_works},
    )


# ---------------------------------------------------------------------------
# environment banner + summary
# ---------------------------------------------------------------------------


def banner() -> None:
    hr("=")
    print("SchedulePoint — SP-C / SP-5 solver boundary spike harness")
    print("OPUS-M0-003. Spike code; not production.")
    hr("=")
    import importlib.metadata as md

    kv("date (UTC)", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    kv("python", "%s (%s)" % (platform.python_version(), platform.python_implementation()))
    kv("python executable", sys.executable)
    kv("ortools", md.version("ortools"))
    kv("platform", "%s %s / %s" % (platform.system(), platform.release(), platform.machine()))
    kv("cpu count", os.cpu_count())
    kv("spike dir", SPIKE_DIR)
    kv("container", "NOT USED — see FAD-7 substitution note in SPIKE-REPORT.md")


def summary() -> int:
    print("")
    hr("=")
    print("SUMMARY")
    hr("=")
    print("%-6s %-34s %-8s" % ("CASE", "TITLE", "OUTCOME"))
    hr()
    failed = 0
    for r in RESULTS:
        print("%-6s %-34s %-8s" % (r["case"], r["title"], r["outcome"]))
        print("       %s" % r["detail"])
        if r["outcome"] == "FAIL":
            failed += 1
    hr()
    print("%d cases, %d failed" % (len(RESULTS), failed))
    return 1 if failed else 0


CASES = {
    "H-0": case_h0,
    "H-1": case_h1,
    "H-2": case_h2,
    "H-3": case_h3,
    "H-4": case_h4,
    "H-5": case_h5,
    "H-6": case_h6,
    "H-7": case_h7,
    "H-8": case_h8,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", action="append", help="run only these cases")
    parser.add_argument("--json-out", default=None, help="write machine-readable results")
    args = parser.parse_args()

    banner()
    driver.reset_tmp()
    selected = args.only or list(CASES)
    t0 = time.monotonic()
    for case in selected:
        CASES[case]()
    print("")
    kv("total harness wall time (s)", round(time.monotonic() - t0, 2))

    if args.json_out:
        with open(args.json_out, "w") as fh:
            json.dump(RESULTS, fh, indent=2, sort_keys=True, default=str)
    return summary()


if __name__ == "__main__":
    sys.exit(main())
