"""Solver worker entry point — **ONE SOLVE PER SUBPROCESS**.

ADR-0020 and SPEC-04 §2, mechanism 3:

    One solve occupies one worker subprocess. If 1 and 2 do not return within a
    grace period, the **subprocess is killed** … Its cost is that the subprocess
    boundary is mandatory: a solve that shares a process with the worker's
    control loop cannot be killed without killing the control loop.

So this process reads exactly one request, produces exactly one response, and
exits. That is not a simplification for a first milestone; it is the property
that makes cancellation a guarantee.

## Transport

Stdio: one ``SolveRequest`` JSON document on stdin, one ``SolveResponse`` JSON
document on stdout, structured events on stderr. The envelope is
transport-neutral and moves to an authenticated HTTP channel unchanged when the
worker becomes its own service (SPEC-10 §2). Stdio was chosen for the same
reason the spike chose it: it makes *the parent can terminate this and lose
nothing else* visible without a server framework in the way.

## The order of operations is a security decision

    authenticate -> validate -> install the egress guard -> solve

Authentication is **first**, before a single field of the payload has been read.
A validator walking an unverified document is a parser exposed to an
unauthenticated party. The egress guard is installed before the solve and after
validation, so a refused request never even reaches the code that could open a
socket.

## Exit codes

``0``  a response was produced — any solver status, including ``INFEASIBLE``
``2``  the request was refused (auth, protocol) — a response was still written
``3``  the worker crashed — an error response was written if it could be

A terminated worker writes nothing at all, and the **parent** attributes
``killed``. That asymmetry is deliberate and is why ``killed`` never appears as a
self-report.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, Optional

if __package__ in (None, ""):  # allow `python solver/schedulepoint_solver/__main__.py`
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = "schedulepoint_solver"

from . import auth, model as solver_model, protocol as P, runtime as R, stub_solver
from .cancellation import CancelChannel
from .egress_guard import install as install_egress_guard

#: The largest request this worker will read, in bytes. The mirror of
#: `MAX_SOLVER_RESPONSE_BYTES` on the platform side: the parent bounds what it
#: reads from an untrusted child, and the child bounds what it reads from a
#: channel it did not create. Neither side gets to be the only one that cares.
MAX_REQUEST_BYTES = 8 * 1024 * 1024


def _event(name: str, **fields: Any) -> None:
    """A structured stderr line.

    **The model is never logged in full** (SPEC-04 §1.1) and no payload, no
    assignment, no identifier beyond the attribution labels ever appears here.
    What is emitted is counts, durations, and the context ids the request
    carried — which SPEC-04 §1.1 defines as "labels for attribution, not
    authorization" and which the worker never branches on.
    """
    fields["event"] = name
    fields["tsMonotonic"] = round(time.monotonic(), 6)
    sys.stderr.write(P.canonical_dumps(fields) + "\n")
    sys.stderr.flush()


def _write_frame(frame: bytes) -> None:
    """Write a framed message: the auth line, a newline, then the body bytes."""
    sys.stdout.buffer.write(frame)
    sys.stdout.buffer.flush()


def _write_unsigned_refusal(
    request: Optional[Dict[str, Any]], code: str, message: str
) -> None:
    """A refusal the worker cannot MAC, declared as unsigned rather than absent."""
    response = P.error_response(request, code, message)
    body = P.canonical_dumps(response).encode("utf-8")
    _write_frame(auth.unsigned_auth_line(code) + auth.FRAME_SEPARATOR + body)


def _dispatch(snapshot, parameters, control, channel):
    """Route the solve. **The default path is the REAL CP-SAT model.**

    OPUS-M4-002 replaced the stub model with `cpsat_adapter`, and the ordinary
    request — no `stubBehaviour`, or `candidate` — goes there. `dwell` and
    `wedged` are RETAINED, deliberately and narrowly: they are the only way to
    exercise SPEC-04 §2's mechanism 3 (a solve that does not return, killed by
    the parent) and a mid-solve cancellation with a *known* dwell, and M4-001's
    kill/cancel/timeout proofs are anchored to them. Retiring them would retire
    those proofs, which the packet forbids — they are re-anchored, not retired,
    and the real solve is exercised for cancellation as well.

    `wedged` remains a named hazard reachable only from an authenticated request
    that asks for it by name.
    """
    behaviour = control.get("stubBehaviour", stub_solver.BEHAVIOUR_CANDIDATE)
    if behaviour in (stub_solver.BEHAVIOUR_DWELL, stub_solver.BEHAVIOUR_WEDGED):
        return stub_solver.solve(snapshot, parameters, control, channel)
    if behaviour != stub_solver.BEHAVIOUR_CANDIDATE:
        raise P.ProtocolError(
            "unknown_stub_behaviour",
            "control.stubBehaviour %r is not one of %s"
            % (behaviour, list(stub_solver.BEHAVIOURS)),
        )
    # The one import of the one module allowed to import OR-Tools (ADR-0006).
    # Imported HERE rather than at module scope because the spike measured
    # `import ortools` at 200-630 ms and a refused request must not pay it.
    from . import cpsat_adapter

    try:
        return cpsat_adapter.solve(snapshot, parameters, control, channel)
    except solver_model.ModelError as exc:
        raise P.ProtocolError(exc.code, exc.message)


def main(argv: Optional[list] = None) -> int:
    del argv  # the worker takes no arguments; everything arrives in the envelope

    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        _write_unsigned_refusal(None, "request_too_large", "request exceeds the size limit")
        return 2

    # 1. Split the frame and AUTHENTICATE THE BYTES AS RECEIVED.
    #
    # Nothing below this line runs for an unauthenticated caller, and — the part
    # that matters — the body is not even PARSED until its MAC verifies. The MAC
    # covers `body` verbatim; no canonical form is re-derived on either side, so
    # a non-ASCII period name or a CJK location cannot make an honest request
    # look forged.
    try:
        auth_line, body = auth.split_frame(raw)
        auth.verify_request_frame(auth_line, body)
        key_id, secret = auth.load_key()
        request_nonce = json.loads(auth_line.decode("utf-8")).get("nonce")
    except auth.AuthenticationError as exc:
        _write_unsigned_refusal(None, exc.code, exc.message)
        return 2

    def refuse(code, message):
        response = P.error_response(request if isinstance(request, dict) else None, code, message)
        _write_frame(auth.frame_response(response, request_nonce, key_id, secret, P.canonical_dumps))

    # 2. Parse. `RecursionError` is caught alongside `ValueError` because
    # CPython's JSON decoder recurses per nesting level: a deeply nested document
    # raises RecursionError, which `except ValueError` does not catch. Uncaught,
    # it killed the worker before any response was written, and the parent then
    # attributed the silence as a *kill* — a structured refusal reported as a
    # terminated process. Post-authentication now, so it is a robustness guard
    # rather than a boundary control, but an unhandled crash is never the right
    # answer to a malformed document.
    request = {}
    try:
        request = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, RecursionError):
        refuse("malformed_json", "request body was not valid JSON")
        return 2

    # 3. Validate. Rejected, never guessed at (SPEC-04 §1.2).
    try:
        P.validate_request(request)
    except P.ProtocolError as exc:
        refuse(exc.code, exc.message)
        return 2

    context = request["context"]
    parameters = request["parameters"]
    control = request["control"]
    snapshot = request["snapshot"]

    # 4. The egress guard, before any solve and after validation.
    try:
        guard = install_egress_guard()
    except Exception as exc:  # noqa: BLE001 - a boundary failure must be reported
        refuse("egress_guard_failed", type(exc).__name__)
        return 2

    channel = CancelChannel(
        channel=control.get("cancelChannel", "none"),
        cancel_file=control.get("cancelFile"),
    )
    channel.start()

    _event(
        "worker_ready",
        pid=os.getpid(),
        organizationId=context["organizationId"],
        groupId=context["groupId"],
        buildRunId=context["buildRunId"],
        correlationId=context["correlationId"],
        canonicalInputHash=request["canonicalInputHash"],
        egressGuard=guard["state"],
        cancelChannel=channel.channel,
    )

    # A test hook the parent uses to know the solve has actually STARTED, which
    # is what makes "cancelled mid-solve" and "killed mid-solve" mean what they
    # say instead of racing process startup.
    ready_file = control.get("readyFile")
    if isinstance(ready_file, str) and ready_file:
        with open(ready_file, "w") as handle:
            handle.write(str(os.getpid()))

    _event("solve_start", pid=os.getpid())
    started = time.monotonic()
    try:
        result = _dispatch(snapshot, parameters, control, channel)
    except P.ProtocolError as exc:
        channel.stop()
        refuse(exc.code, exc.message)
        return 2
    except Exception as exc:  # noqa: BLE001 - a worker must report, not hide
        channel.stop()
        response = P.error_response(
            request,
            "solver_exception",
            type(exc).__name__,
            status=P.STATUS_FAILED,
            termination_reason=P.TERMINATION_CRASHED,
        )
        _write_frame(auth.frame_response(response, request_nonce, key_id, secret, P.canonical_dumps))
        return 3
    elapsed = time.monotonic() - started
    channel.stop()
    _event("solve_done", status=result["status"], elapsedSeconds=round(elapsed, 6))

    response = {
        "protocolVersion": P.PROTOCOL_VERSION,
        "messageType": P.MESSAGE_TYPE_RESPONSE,
        "context": context,
        "snapshotId": request["snapshotId"],
        "canonicalInputHash": request["canonicalInputHash"],
        "status": result["status"],
        "terminationReason": result["terminationReason"],
        "assignments": result["assignments"],
        "unfilledDemand": result["unfilled"],
        "objectiveTiers": result.get("objectiveTiers"),
        "objectiveValue": result.get("objectiveValue"),
        # OPUS-M4-004. The objective this WORKER BUILD carries, and the search
        # the solve actually did (SPEC-04 §4's reproduction record). Counts and
        # durations only — the model is never emitted, in full or in part.
        #
        # The profile is stated HERE rather than by whichever code path ran,
        # because it is a property of the worker package and not of the model:
        # the question the platform asks with it is "are you the build I
        # compiled against?", and a `dwell` or `wedged` path that answered
        # nothing would make that question unaskable exactly where the
        # cancellation and kill proofs live. Every response carries it; what the
        # solve DID with it is `objectiveTiers`, which is a different fact.
        "objectiveProfile": {
            "profileId": solver_model.OBJECTIVE_PROFILE_ID,
            "scale": solver_model.OBJECTIVE_SCALE,
            "digest": solver_model.objective_profile_digest(),
        },
        "statistics": result.get("statistics"),
        "explanation": result.get("explanation"),
        "runtime": R.runtime_record(parameters),
        "cancellation": channel.report(),
        "egressGuard": guard,
        "error": None,
    }
    _write_frame(auth.frame_response(response, request_nonce, key_id, secret, P.canonical_dumps))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
