"""A deliberately misbehaving worker — TEST FIXTURE, never shipped.

The platform must refuse a worker response it cannot believe: malformed,
oversized, unsigned, forged, protocol-incompatible, or *dishonest* about what
happened. Proving that needs a worker that misbehaves on demand.

**Why this is a fixture and not a mode of the real worker.** The real worker's
stub has three behaviours (`candidate`, `dwell`, `wedged`) and every one of them
is a genuine solve behaviour that exists so a boundary property — a round trip, a
cancellation, a termination — can be exercised. Fault injection is a different
thing: it simulates a *broken or hostile* worker, and building that capability
into the production image would ship, to production, the ability to emit a
response the platform is designed to reject. The refusals belong to the platform;
the hostility belongs here.

Modes, each matching one arm of `solverResponseVerdict`:

``malformed``       write bytes that are not JSON
``not-an-object``   write valid JSON that is not an object
``oversized``       write past the platform's response byte cap
``unsigned``        a well-formed, plausible response with no MAC
``forged-mac``      a well-formed response with a MAC that does not verify
``wrong-nonce``     a correctly-MACed response bound to a DIFFERENT request
``bad-protocol``    a protocol version outside the supported window
``unknown-status``  a status outside the closed set
``dishonest``       ``CANCELLED`` with termination reason ``deadline`` — the
                    EV-M0-SPC H-6 lie, stated as plainly as it can be
``hash-mismatch``   a response naming an input hash that was never dispatched
``silent``          exit 0 having written nothing at all
``env-probe``       not hostile at all: reports, through the STATUS, what the
                    child's environment contained. ``MODEL_INVALID`` means a
                    ``SP_PG_*`` database credential reached the worker;
                    ``FEASIBLE`` means it did not AND the probe demonstrably can
                    read its environment (it saw ``SP_SOLVER_IMAGE_DIGEST``);
                    ``UNKNOWN`` means the probe saw nothing at all, which would
                    make the proof vacuous and is therefore reported distinctly
                    rather than collapsed into "fine"

It reads the request so that ``wrong-nonce`` and ``hash-mismatch`` can be
*plausible* — a fixture that could not echo the context would be refused for the
wrong reason and the proof would pass without testing anything.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys

# `apps/api/test/support/` -> the worktree root -> `solver/`. Python puts the
# SCRIPT's directory on `sys.path`, not the working directory, so the package has
# to be located explicitly even though the client sets `cwd` to `solver/`.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "solver"))

# Reused rather than respelled: the MAC is over the CANONICAL form, so a fixture
# with its own serialiser would produce responses that fail to verify for a
# formatting reason and the proofs would pass without testing the property.
from schedulepoint_solver.protocol import canonical_dumps  # noqa: E402

RESPONSE_DOMAIN = "SP-SOLVER-RPC-v1|response|"
SCHEME = "sp-hmac-sha256-mutual-v1"
PRINCIPAL = "schedulepoint-solver"


def mac_over(body, parts, secret):
    """The framed MAC: prefix over the auth metadata, then the body BYTES.

    Mirrors `auth.py` exactly. The fixture signs the same bytes it writes, so a
    mode that is supposed to be VALID really is — otherwise every hostile mode
    would 'pass' for the wrong reason.
    """
    prefix = "%s%s\n%s\n%s\n%s\n" % (
        RESPONSE_DOMAIN, parts["scheme"], parts["principal"], parts["keyId"], parts["nonce"],
    )
    return hmac.new(secret, prefix.encode("utf-8") + body, hashlib.sha256).hexdigest()


def write_frame(auth_obj, body):
    sys.stdout.buffer.write(
        json.dumps(auth_obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
        + b"\n"
        + body
    )
    sys.stdout.buffer.flush()


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "malformed"
    raw = sys.stdin.buffer.read()
    # The request is FRAMED: auth line, newline, body. The fixture only needs the
    # nonce to echo and the body to read, so it splits rather than verifying.
    index = raw.find(b"\n")
    auth_line, body_bytes = (raw[:index], raw[index + 1 :]) if index != -1 else (b"{}", raw)
    try:
        request = json.loads(body_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        request = {}
    try:
        request_auth = json.loads(auth_line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        request_auth = {}

    if mode == "malformed":
        write_frame({"scheme": SCHEME, "principal": PRINCIPAL, "signed": False}, b"this is not JSON {{{")
        return 0
    if mode == "not-an-object":
        write_frame({"scheme": SCHEME, "principal": PRINCIPAL, "signed": False}, b"[1, 2, 3]")
        return 0
    if mode == "oversized":
        # Past the platform's 1 MiB cap, streamed so the parent has to decide to
        # stop reading rather than merely to reject what it read.
        sys.stdout.buffer.write(b'{"signed":false}\n{"filler":"')
        for _ in range(1200):
            sys.stdout.buffer.write(b"x" * 1024)
        sys.stdout.buffer.write(b'"}')
        sys.stdout.buffer.flush()
        return 0
    if mode == "silent":
        return 0

    secret = os.environ.get("SP_SOLVER_RPC_SECRET", "").encode("utf-8")
    key_id = os.environ.get("SP_SOLVER_RPC_KEY_ID", "")
    context = request.get("context", {}) if isinstance(request, dict) else {}
    nonce = request_auth.get("nonce", "") if isinstance(request_auth, dict) else ""
    input_hash = request.get("canonicalInputHash", "0" * 64) if isinstance(request, dict) else "0" * 64

    response = {
        "protocolVersion": 1,
        "messageType": "SolveResponse",
        "context": context,
        "canonicalInputHash": input_hash,
        "status": "FEASIBLE",
        "terminationReason": "completed",
        "assignments": [],
        "runtime": {
            "imageDigest": "hostile-fixture",
            "solverVersion": "hostile-fixture",
            "compilerVersion": "0",
            "platformArch": "hostile-fixture",
            "languageRuntime": "hostile-fixture",
            "reproducibilityMode": "best-effort",
        },
        "error": None,
    }

    if mode == "env-probe":
        observed = sorted(name for name in os.environ if name.startswith("SP_"))
        if any(name.startswith("SP_PG_") for name in observed):
            response["status"] = "MODEL_INVALID"
        elif "SP_SOLVER_IMAGE_DIGEST" in observed:
            response["status"] = "FEASIBLE"
        else:
            response["status"] = "UNKNOWN"
    elif mode == "bad-protocol":
        response["protocolVersion"] = 99
    elif mode == "unknown-status":
        response["status"] = "PROBABLY_FINE"
    elif mode == "dishonest":
        response["status"] = "CANCELLED"
        response["terminationReason"] = "deadline"
    elif mode == "hash-mismatch":
        response["canonicalInputHash"] = "f" * 64

    body = canonical_dumps(response).encode("utf-8")

    if mode == "unsigned":
        write_frame({"scheme": SCHEME, "principal": PRINCIPAL, "signed": False}, body)
        return 0

    parts = {
        "scheme": SCHEME,
        "principal": PRINCIPAL,
        "keyId": key_id,
        "nonce": "0" * 64 if mode == "wrong-nonce" else nonce,
    }
    auth_obj = dict(parts)
    auth_obj["mac"] = "0" * 64 if mode == "forged-mac" else mac_over(body, parts, secret)
    write_frame(auth_obj, body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
