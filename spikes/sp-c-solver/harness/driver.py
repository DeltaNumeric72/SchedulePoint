"""Harness driver: one worker subprocess per solve request.

SPIKE CODE — SP-C / SP-5.

This stands in for the platform's solver-dispatch process class. The property it
exists to demonstrate is ADR-0020's: **one solve occupies one subprocess**, so
the parent can always end a solve by ending a process, and ending it costs the
parent nothing.

The driver imports no solver and never reads the problem's semantics — it moves
bytes and manages a process.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional

SPIKE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP_DIR = os.path.join(SPIKE_DIR, ".tmp")
WORKER_TMP = os.path.join(TMP_DIR, "worker-tmp")
# Measured: with no HOME in the environment, worker cold start on macOS goes
# from ~0.23s to ~0.77s — half a second of pure overhead on every solve, and
# one solve is one process. An over-sanitised environment is not free.
WORKER_HOME = os.path.join(TMP_DIR, "worker-home")

DEFAULT_PARAMETERS = {
    "random_seed": 20260801,
    "num_search_workers": 8,
    "max_time_in_seconds": 30.0,
    "log_search_progress": False,
}


def reset_tmp() -> None:
    shutil.rmtree(TMP_DIR, ignore_errors=True)
    os.makedirs(WORKER_TMP, exist_ok=True)
    os.makedirs(WORKER_HOME, exist_ok=True)


def tmp_path(name: str) -> str:
    os.makedirs(TMP_DIR, exist_ok=True)
    return os.path.join(TMP_DIR, name)


def load_problem(name: str) -> Dict[str, Any]:
    with open(os.path.join(SPIKE_DIR, "problems", "%s.json" % name)) as fh:
        return json.load(fh)


def build_request(
    problem: Dict[str, Any],
    parameters: Optional[Dict[str, Any]] = None,
    control: Optional[Dict[str, Any]] = None,
    explanation: Optional[Dict[str, Any]] = None,
    correlation_id: str = "spc-harness",
    auth_scheme: str = "placeholder-internal-mtls",
) -> Dict[str, Any]:
    params = dict(DEFAULT_PARAMETERS)
    params.update(parameters or {})
    return {
        "protocol_version": 1,
        "message_type": "SolveRequest",
        # Authenticated-call placeholder (SPEC-04 §1.1). Shape only; the spike
        # verifies nothing cryptographically and says so in the response.
        "auth": {
            "scheme": auth_scheme,
            "principal": "solver-dispatch",
            "credential": None,
        },
        # Attribution labels, not authorization (SPEC-04 §1.1).
        "context": {
            "organization_id": "org_00000000-0000-4000-8000-000000000001",
            "group_id": "grp_00000000-0000-4000-8000-000000000002",
            "build_run_id": "run_%s" % correlation_id,
            "correlation_id": correlation_id,
        },
        "solve_parameters": params,
        "control": control or {},
        "explanation": explanation or {},
        "problem": problem,
    }


class RunResult:
    def __init__(self) -> None:
        self.returncode: Optional[int] = None
        self.pid: Optional[int] = None
        self.response: Optional[Dict[str, Any]] = None
        self.stdout_bytes: int = 0
        self.stderr_events: List[Dict[str, Any]] = []
        self.stderr_raw: str = ""
        self.parent_wall_seconds: float = 0.0
        self.request_bytes: int = 0
        self.request_encode_seconds: float = 0.0
        self.response_decode_seconds: float = 0.0
        self.action_at_offset_seconds: Optional[float] = None
        self.exit_signal: Optional[int] = None
        self.timed_out: bool = False

    @property
    def killed_by_signal(self) -> bool:
        return self.returncode is not None and self.returncode < 0

    def event(self, name: str) -> Optional[Dict[str, Any]]:
        for e in self.stderr_events:
            if e.get("event") == name:
                return e
        return None


def run_solve(
    request: Dict[str, Any],
    ready_file: Optional[str] = None,
    on_ready: Optional[Callable[[subprocess.Popen, "RunResult"], None]] = None,
    ready_delay_seconds: float = 0.0,
    timeout_seconds: float = 180.0,
    env_overrides: Optional[Dict[str, str]] = None,
) -> RunResult:
    """Spawn one worker, feed it one request, collect one response.

    ``on_ready`` fires once the worker has reported that the solve has actually
    begun (it writes ``ready_file``), which is what makes the cancellation and
    kill cases land *mid-solve* rather than during startup.
    """
    result = RunResult()
    os.makedirs(WORKER_TMP, exist_ok=True)
    os.makedirs(WORKER_HOME, exist_ok=True)

    t0 = time.monotonic()
    payload = json.dumps(request)
    result.request_encode_seconds = time.monotonic() - t0
    result.request_bytes = len(payload.encode("utf-8"))

    cmd = [sys.executable, "-m", "worker.main"]
    if ready_file:
        if os.path.exists(ready_file):
            os.remove(ready_file)
        cmd += ["--ready-file", ready_file]

    # Deliberately minimal: no database URL, no credentials, no inherited
    # secrets. HOME is present and scoped to the spike — see WORKER_HOME.
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": WORKER_HOME,
        "TMPDIR": WORKER_TMP,
        "PYTHONHASHSEED": "0",  # removes one source of run-to-run variation
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if env_overrides:
        env.update(env_overrides)

    start = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        cwd=SPIKE_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
        start_new_session=True,  # own process group: orphan checks are meaningful
    )
    result.pid = proc.pid

    watcher: Optional[threading.Thread] = None
    if on_ready is not None:
        def _wait_and_act() -> None:
            deadline = time.monotonic() + timeout_seconds
            while time.monotonic() < deadline:
                if ready_file and os.path.exists(ready_file):
                    break
                if proc.poll() is not None:
                    return
                time.sleep(0.005)
            if ready_delay_seconds:
                time.sleep(ready_delay_seconds)
            if proc.poll() is None:
                result.action_at_offset_seconds = time.monotonic() - start
                on_ready(proc, result)

        watcher = threading.Thread(target=_wait_and_act, name="ready-watcher", daemon=True)
        watcher.start()

    try:
        out, err = proc.communicate(input=payload, timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        result.timed_out = True
        proc.kill()
        out, err = proc.communicate()
    result.parent_wall_seconds = time.monotonic() - start
    result.returncode = proc.returncode
    if proc.returncode is not None and proc.returncode < 0:
        result.exit_signal = -proc.returncode

    if watcher is not None:
        watcher.join(timeout=1.0)

    result.stdout_bytes = len(out.encode("utf-8"))
    result.stderr_raw = err
    for line in err.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            result.stderr_events.append(json.loads(line))
        except ValueError:
            pass

    if out.strip():
        t = time.monotonic()
        try:
            result.response = json.loads(out)
        except ValueError:
            result.response = None
        result.response_decode_seconds = time.monotonic() - t

    return result


# ---------------------------------------------------------------------------
# Cancellation and kill actions, used as ``on_ready`` callbacks
# ---------------------------------------------------------------------------


def action_touch_cancel_file(path: str) -> Callable[[subprocess.Popen, RunResult], None]:
    def _act(proc: subprocess.Popen, result: RunResult) -> None:
        with open(path, "w") as fh:
            fh.write("cancel")
    return _act


def action_send_signal(signum: int) -> Callable[[subprocess.Popen, RunResult], None]:
    def _act(proc: subprocess.Popen, result: RunResult) -> None:
        os.kill(proc.pid, signum)
    return _act


def action_sigkill() -> Callable[[subprocess.Popen, RunResult], None]:
    return action_send_signal(signal.SIGKILL)


# ---------------------------------------------------------------------------
# Process-table and filesystem hygiene checks (H-5)
# ---------------------------------------------------------------------------


def process_table() -> List[Dict[str, str]]:
    out = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,stat=,command="],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        rows.append({"pid": parts[0], "ppid": parts[1], "stat": parts[2], "command": parts[3]})
    return rows


def worker_processes() -> List[Dict[str, str]]:
    """Any process still running the worker module, whatever its parent."""
    return [
        row
        for row in process_table()
        if "worker.main" in row["command"] and "grep" not in row["command"]
    ]


def zombie_or_orphan_workers() -> List[Dict[str, str]]:
    return [
        row
        for row in worker_processes()
        if row["ppid"] == "1" or row["stat"].startswith("Z")
    ]


def worker_tmp_listing() -> List[str]:
    if not os.path.isdir(WORKER_TMP):
        return []
    found = []
    for root, dirs, files in os.walk(WORKER_TMP):
        for name in sorted(files):
            found.append(os.path.relpath(os.path.join(root, name), WORKER_TMP))
    return sorted(found)
