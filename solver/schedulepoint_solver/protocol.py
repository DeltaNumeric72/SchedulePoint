"""The versioned solver RPC envelope — SPEC-04 §1.1, §1.2, §2.

**Production code.** OPUS-M4-001, doc 35 §6a. It supersedes the SP-C spike's
``worker/protocol.py``, which was evidence and said so on every line.

Two properties this module exists to hold, both of which are cheaper to keep
from the first commit than to restore later:

* **No solver type appears here.** This module knows about problems, parameters,
  statuses and termination reasons; it does not know that CP-SAT — or even a
  constraint solver — exists. Only a future ``cpsat_adapter`` module may import
  ``ortools``, and a test asserts that. SPEC-04 §1: "the domain remains
  solver-neutral … no domain module imports the solver or knows it is Python",
  and the same discipline pointed the other way keeps the engine replaceable.
* **Nothing is guessed.** ``protocol_version`` is checked against a bounded
  window and anything outside it is **rejected** (SPEC-04 §1.2). An unknown
  field, an absent field, a wrong type: each is a named refusal with a code, not
  a default that quietly changes what the worker solved.

The transport is deliberately not this module's business. The envelope travels
over stdio between a parent and a one-solve subprocess today — chosen because it
makes the property that matters (*the parent can terminate the solve and lose
nothing else*) visible without a server framework in the way — and it moves to an
authenticated HTTP channel unchanged.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional, Tuple

# ---------------------------------------------------------------------------
# Version windows (SPEC-04 §1.2)
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = 1
SUPPORTED_PROTOCOL_VERSIONS: Tuple[int, ...] = (1,)

#: The canonical-input document shape this worker understands.
#:
#: **2 since OPUS-M4-002 (FAD-38).** v2 appends three vocabularies — staff groups
#: with their members, valid groups with their shift types, and the qualification
#: id/key/status triple — without which RK-RULING-02/03 cannot be modelled and a
#: rule naming a qualification KEY cannot be resolved to the ids the holdings
#: carry. v1 is NOT accepted: the window is the SPEC-04 §1.2 rule applied to the
#: document, and a v1 document read as a v2 one would silently model a group with
#: no staff groups rather than refusing a problem it cannot pose.
#:
#: **3 since OPUS-M5-004 (doc 42 5h).** v3 appends ONE field,
#: ``requestProjection`` — SPEC-08 6's four rows, whose closing line requires
#: them to be "part of the pinned solver_inputs snapshot". ``HardOff`` is
#: CONSUMED by the model (``model.Problem.cells``): a membership is not a
#: candidate on a date it is off, which is doc 08 3.2's "Availability (approved
#: absence, vacation) | Candidate unavailability window" reaching an
#: implementation for the first time. Without the bump a v2 document — one with
#: no absences in it — would be read as a v3 document whose group happens to have
#: none, and the rebuild would schedule people on their approved days off: SPEC-08
#: R-14's exact failure. So v2 is refused by version rather than misread.
SNAPSHOT_SCHEMA_VERSION = 3
SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS: Tuple[int, ...] = (3,)

MESSAGE_TYPE_REQUEST = "SolveRequest"
MESSAGE_TYPE_RESPONSE = "SolveResponse"

# ---------------------------------------------------------------------------
# Outcome vocabulary (SPEC-04 §2) — the mirror of
# packages/domain/src/ports/solver-port.ts. Two copies exist because the two
# runtimes cannot share one; `apps/api/test/solver/worker-invariants.test.ts`
# reads THIS file and fails if they ever diverge, which is what makes the
# duplication safe rather than merely noted.
# ---------------------------------------------------------------------------

STATUS_OPTIMAL = "OPTIMAL"
STATUS_FEASIBLE = "FEASIBLE"
STATUS_INFEASIBLE = "INFEASIBLE"
STATUS_MODEL_INVALID = "MODEL_INVALID"
STATUS_UNKNOWN = "UNKNOWN"
STATUS_CANCELLED = "CANCELLED"
STATUS_TIMEOUT = "TIMEOUT"
STATUS_FAILED = "FAILED"

SOLVER_STATUSES: Tuple[str, ...] = (
    STATUS_OPTIMAL,
    STATUS_FEASIBLE,
    STATUS_INFEASIBLE,
    STATUS_MODEL_INVALID,
    STATUS_UNKNOWN,
    STATUS_CANCELLED,
    STATUS_TIMEOUT,
    STATUS_FAILED,
)

TERMINATION_COMPLETED = "completed"
TERMINATION_DEADLINE = "deadline"
TERMINATION_USER_CANCELLED = "user_cancelled"
#: Never self-reported — a terminated process writes nothing. The parent
#: attributes it. Named here so the vocabulary is complete in one place.
TERMINATION_KILLED = "killed"
TERMINATION_CRASHED = "crashed"
TERMINATION_REJECTED = "rejected"

TERMINATION_REASONS: Tuple[str, ...] = (
    TERMINATION_COMPLETED,
    TERMINATION_DEADLINE,
    TERMINATION_USER_CANCELLED,
    TERMINATION_KILLED,
    TERMINATION_CRASHED,
    TERMINATION_REJECTED,
)


class ProtocolError(Exception):
    """A malformed or unsupported request. Rejected, never guessed at."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Canonical JSON — the MAC and the hash both depend on it
# ---------------------------------------------------------------------------


def canonical_dumps(obj: Any) -> str:
    """Byte-stable JSON: sorted keys, fixed separators, ASCII-escaped, no NaN.

    This is the Python half of ``canonicalStringify``
    (``packages/domain/src/rules/serialize.ts``) and must agree with it byte for
    byte, because a message authentication code computed over a *differently*
    serialised object is a MAC over a different message — the failure would look
    like a forged request rather than like a formatting difference, which is the
    worst possible disguise for a bug.

    Three settings carry that agreement, and each one closes a real divergence:

    * ``sort_keys`` — ``JSON.stringify`` preserves insertion order; Python's
      ``dict`` does too. Sorting on both sides removes the dependence entirely.
    * ``separators=(",", ":")`` — Python's default inserts a space after ``:``
      and ``,``; JavaScript's does not.
    * ``allow_nan=False`` — ``json.dumps`` emits the non-standard ``NaN`` token
      by default, which no JSON parser is obliged to read back. ``canonicalize``
      throws for the same input. A non-finite number never enters a canonical
      artifact silently on either side.

    ``ensure_ascii=True`` matches ``JSON.stringify``'s treatment of lone
    surrogates and keeps the wire bytes 7-bit, so no intermediate hop can
    re-encode the message under the MAC.
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


# ---------------------------------------------------------------------------
# Structural validation
#
# Hand-rolled rather than schema-driven: the worker image carries the solver and
# nothing else it does not need, and a validation library in the image is a
# second dependency chain, a second SBOM entry and a second patch stream
# (SPEC-04 §1, ADR-0020's "negative" column) for a document with fifteen fields.
# ---------------------------------------------------------------------------


def _require(condition: bool, code: str, message: str) -> None:
    if not condition:
        raise ProtocolError(code, message)


def _field(source: Dict[str, Any], key: str, types: tuple, where: str) -> Any:
    """One required field of a known type.

    ``bool`` is excluded from every numeric expectation on purpose: in Python
    ``isinstance(True, int)`` is ``True``, so a request carrying
    ``"numSearchWorkers": true`` would sail through a naive check and then be
    used as the number 1. A silently coerced parameter is exactly the class of
    defect the reproducibility record exists to make impossible, so it is refused
    at the boundary instead.
    """
    _require(isinstance(source, dict), "not_an_object", "%s must be an object" % where)
    _require(key in source, "missing_field", "%s.%s is required" % (where, key))
    value = source[key]
    numeric_expected = bool not in types
    ok = isinstance(value, types) and not (numeric_expected and isinstance(value, bool))
    _require(ok, "bad_type", "%s.%s has the wrong type" % (where, key))
    return value


def validate_request(request: Any) -> Dict[str, Any]:
    """Validate a ``SolveRequest`` envelope. Raises :class:`ProtocolError`.

    Authentication is **not** checked here — ``auth.py`` owns that, and it runs
    before this. The order matters: a request whose MAC does not verify must be
    refused without this function having read a single field of its payload,
    because reading is the beginning of trusting.
    """
    _require(isinstance(request, dict), "not_an_object", "request must be a JSON object")

    version = _field(request, "protocolVersion", (int,), "request")
    _require(
        version in SUPPORTED_PROTOCOL_VERSIONS,
        "unsupported_protocol_version",
        "protocolVersion %s is outside the supported window %s"
        % (version, list(SUPPORTED_PROTOCOL_VERSIONS)),
    )

    message_type = _field(request, "messageType", (str,), "request")
    _require(
        message_type == MESSAGE_TYPE_REQUEST,
        "unsupported_message_type",
        "messageType %r is not handled by this worker" % message_type,
    )

    context = _field(request, "context", (dict,), "request")
    for name in ("organizationId", "groupId", "buildRunId", "correlationId"):
        _field(context, name, (str,), "request.context")

    _field(request, "snapshotId", (str,), "request")
    input_hash = _field(request, "canonicalInputHash", (str,), "request")
    _require(
        len(input_hash) == 64 and all(c in "0123456789abcdef" for c in input_hash),
        "bad_value",
        "canonicalInputHash must be 64 lowercase hex characters",
    )

    parameters = _field(request, "parameters", (dict,), "request")
    _field(parameters, "randomSeed", (int,), "request.parameters")
    workers = _field(parameters, "numSearchWorkers", (int,), "request.parameters")
    _require(workers >= 1, "bad_value", "numSearchWorkers must be at least 1")
    budget = _field(parameters, "maxTimeInSeconds", (int, float), "request.parameters")
    _require(budget > 0, "bad_value", "maxTimeInSeconds must be positive")
    _require(
        "maxDeterministicTime" in parameters,
        "missing_field",
        "request.parameters.maxDeterministicTime is required (null when not pinned)",
    )
    _field(parameters, "interleaveSearch", (bool,), "request.parameters")

    _require("control" in request, "missing_field", "request.control is required")
    _require(
        isinstance(request["control"], dict),
        "bad_type",
        "request.control must be an object",
    )

    snapshot = _field(request, "snapshot", (dict,), "request")
    validate_snapshot(snapshot)
    return request


def validate_snapshot(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """Validate the canonical input document, structurally.

    Deliberately shallow. The *semantic* refusals — ambiguity, staleness,
    cross-group references, inactive participants, impossible dates, missing
    required input — are decided on the platform side, **before dispatch**
    (``packages/domain/src/ports/solver-snapshot.ts``), because refusing after a
    solve has burned a solve and, far worse, has produced a candidate schedule
    that looks exactly like a good one. What is checked here is only what the
    worker itself must be able to rely on to build a model at all.
    """
    schema_version = _field(snapshot, "snapshotSchemaVersion", (int,), "snapshot")
    _require(
        schema_version in SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
        "unsupported_snapshot_schema_version",
        "snapshotSchemaVersion %s is outside the supported window %s"
        % (schema_version, list(SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS)),
    )
    for name in ("organizationId", "groupId", "periodId", "versionId", "startDate", "endDate"):
        _field(snapshot, name, (str,), "snapshot")
    for name in (
        "shiftTypes",
        "participants",
        "demand",
        "fixedAssignments",
        "ruleRevisions",
        # v2 (FAD-38). Required, not optional: an absent vocabulary and an empty
        # one are different claims, and only the second is a group that has none.
        "staffGroups",
        "validGroups",
        "qualifications",
    ):
        _field(snapshot, name, (list,), "snapshot")
    # v3 (OPUS-M5-004). SPEC-08 6's projection, and an OBJECT rather than a list
    # because it carries one array per row kind. Required, not optional: a v3
    # document without it is a document whose absences are missing rather than
    # absent, and reading it as "this group has none" is R-14's exact failure.
    _field(snapshot, "requestProjection", (dict,), "snapshot")
    _require(
        len(snapshot["shiftTypes"]) > 0,
        "bad_value",
        "snapshot.shiftTypes must be non-empty — an unposed problem is not a hard one",
    )
    _require(
        len(snapshot["participants"]) > 0,
        "bad_value",
        "snapshot.participants must be non-empty",
    )
    return snapshot


def error_response(
    request: Optional[Dict[str, Any]],
    code: str,
    message: str,
    status: str = STATUS_FAILED,
    termination_reason: str = TERMINATION_REJECTED,
) -> Dict[str, Any]:
    """A refusal, in the response shape, so a caller never has to parse stderr."""
    context: Dict[str, Any] = {}
    input_hash = ""
    if isinstance(request, dict):
        if isinstance(request.get("context"), dict):
            context = request["context"]
        if isinstance(request.get("canonicalInputHash"), str):
            input_hash = request["canonicalInputHash"]
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "messageType": MESSAGE_TYPE_RESPONSE,
        "context": context,
        "canonicalInputHash": input_hash,
        "status": status,
        "terminationReason": termination_reason,
        "assignments": None,
        "runtime": None,
        "error": {"code": code, "message": message},
    }
