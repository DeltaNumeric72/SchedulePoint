"""Solver worker entrypoint — ONE SOLVE PER PROCESS.

SPIKE CODE — SP-C / SP-5.

Transport is stdio: a single ``SolveRequest`` JSON document on stdin, a single
``SolveResponse`` JSON document on stdout, structured progress on stderr. HTTP
was the alternative; stdio was chosen because it makes the property that
actually matters — *the parent can SIGKILL the solve and lose nothing else* —
visible without a server framework in the way. The envelope is transport-neutral
and would move to HTTP unchanged.

The process exits after one response. That is not a simplification for the
spike; it is ADR-0020's requirement, and it is what makes cancellation layer 3
(termination) enforceable.

Exit codes
----------
0  a response was produced (any solver status, including INFEASIBLE)
2  the request was rejected (protocol / auth) — a response was still written
3  the worker crashed — an error response was written if possible
   (a SIGKILLed worker writes nothing at all; the parent attributes 'killed')
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from typing import Any, Dict

if __package__ in (None, ""):  # allow `python worker/main.py`
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = "worker"

from . import protocol as P
from .cancellation import CancelChannel
from .egress_guard import install as install_egress_guard

# The worker rejects anything it cannot authenticate. In the spike the
# "verification" is a scheme-name check: the *shape* of the boundary is proven,
# the cryptography is explicitly not.
ACCEPTED_AUTH_SCHEMES = ("placeholder-internal-mtls",)


def _stderr(event: str, **fields: Any) -> None:
    fields["event"] = event
    fields["ts_monotonic"] = round(time.monotonic(), 6)
    sys.stderr.write(P.canonical_dumps(fields) + "\n")
    sys.stderr.flush()


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="SchedulePoint SP-C solver worker")
    parser.add_argument(
        "--ready-file",
        default=None,
        help="path touched once the solve has actually started (test hook)",
    )
    args = parser.parse_args(argv)

    request: Dict[str, Any] = {}
    t_read0 = time.monotonic()
    raw = sys.stdin.read()
    t_read1 = time.monotonic()
    request_bytes = len(raw.encode("utf-8"))

    try:
        request = json.loads(raw)
    except ValueError as exc:
        _write(P.error_response(None, "malformed_json", str(exc)))
        return 2
    t_parse1 = time.monotonic()

    try:
        P.validate_request(request)
    except P.ProtocolError as exc:
        _write(P.error_response(request, exc.code, exc.message))
        return 2

    scheme = request["auth"]["scheme"]
    if scheme not in ACCEPTED_AUTH_SCHEMES:
        _write(
            P.error_response(
                request,
                "unauthenticated",
                "auth scheme %r is not accepted by this worker" % scheme,
            )
        )
        return 2

    guard_status = install_egress_guard()

    problem = request["problem"]
    input_hash = _sha256(P.canonical_dumps(problem))

    control = request["control"]
    channel = CancelChannel(
        channel=control.get("cancel_channel", "none"),
        cancel_file=control.get("cancel_file"),
    )
    channel.start()

    _stderr(
        "worker_ready",
        pid=os.getpid(),
        problem_id=problem["problem_id"],
        input_hash=input_hash,
        request_bytes=request_bytes,
        cancel_channel=channel.channel,
        egress_guard=guard_status,
    )

    # Imported here, after validation, so that a rejected request never even
    # loads the solver. Also keeps `import ortools` inside the adapter module.
    from . import cpsat_adapter

    if args.ready_file:
        with open(args.ready_file, "w") as fh:
            fh.write(str(os.getpid()))
    _stderr("solve_start", pid=os.getpid())

    t_solve0 = time.monotonic()
    try:
        result = cpsat_adapter.solve(
            problem,
            request["solve_parameters"],
            channel,
            use_assumptions=bool(request.get("explanation", {}).get("use_assumptions")),
            assumption_granularity=request.get("explanation", {}).get(
                "assumption_granularity", "instance"
            ),
            assumption_rule_ids=request.get("explanation", {}).get("assumption_rule_ids"),
            stop_via_thread=bool(control.get("stop_via_thread")),
        )
    except Exception as exc:  # noqa: BLE001 - a spike must report, not hide
        channel.stop()
        _write(
            P.error_response(
                request,
                "solver_exception",
                "%s: %s" % (type(exc).__name__, exc),
            )
        )
        return 3
    t_solve1 = time.monotonic()
    channel.stop()
    _stderr("solve_done", status=result["status"])

    response = {
        "protocol_version": P.PROTOCOL_VERSION,
        "message_type": "SolveResponse",
        "context": request["context"],
        "auth_echo": {"scheme": scheme, "verified": False},
        "input_hash": input_hash,
        "status": result["status"],
        "termination_reason": result["termination_reason"],
        "deadline_reached": result["deadline_reached"],
        "solution": result["solution"],
        "sufficient_assumptions": result["sufficient_assumptions"],
        "cancellation": result["cancellation"],
        "reproducibility": result["reproducibility"],
        "error": None,
    }
    if result["solution"] is not None:
        response["solution_hash"] = _sha256(P.canonical_dumps(result["solution"]))
    else:
        response["solution_hash"] = None

    t_ser0 = time.monotonic()
    payload = P.canonical_dumps(response)
    t_ser1 = time.monotonic()

    response["reproducibility"]["serialization"] = {
        "request_bytes": request_bytes,
        # Measured before this telemetry block is attached, so it is a few
        # hundred bytes short of the bytes actually written. Stated, not hidden.
        "response_bytes_excluding_telemetry": len(payload.encode("utf-8")),
        "stdin_read_seconds": round(t_read1 - t_read0, 6),
        "request_parse_seconds": round(t_parse1 - t_read1, 6),
        "response_encode_seconds": round(t_ser1 - t_ser0, 6),
        "solve_call_seconds": round(t_solve1 - t_solve0, 6),
    }

    _write(response)
    return 0


def _write(response: Dict[str, Any]) -> None:
    sys.stdout.write(P.canonical_dumps(response))
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
