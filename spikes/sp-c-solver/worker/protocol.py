"""Versioned, solver-neutral RPC envelope for the SchedulePoint solver worker.

SPIKE CODE — SP-C / SP-5. Not production code.

This module deliberately contains **no solver types at all**. It knows about
problems, rules, objectives, and results; it does not know that CP-SAT, or even
a CP solver, exists. Only ``worker/cpsat_adapter.py`` may import ``ortools``.

Envelope (SPEC-04 §1.1, §1.2)
----------------------------
Every message carries ``protocol_version``. The worker accepts a *bounded
window* of versions and rejects anything outside it rather than guessing.

``auth`` is an **authenticated-call placeholder**. In production this is mutual
authentication on the internal channel (SPEC-04 §1.1). In the spike the field is
present, carried, echoed, and structurally validated so the shape is proven —
but nothing is verified cryptographically. That is a deliberate, recorded gap.

``context`` carries organization_id / group_id / build_run_id / correlation_id.
Per SPEC-04 §1.1 these are **labels for attribution, not authorization**: the
worker echoes them and never uses them to make a decision. The worker holds no
database credential and performs no I/O other than stdin/stdout/stderr.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Version windows
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = 1
SUPPORTED_PROTOCOL_VERSIONS: Tuple[int, ...] = (1,)

PROBLEM_SCHEMA_VERSION = "1.0.0"
SUPPORTED_PROBLEM_SCHEMA_VERSIONS: Tuple[str, ...] = ("1.0.0",)

SOLUTION_SCHEMA_VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# Solver-neutral vocabulary
# ---------------------------------------------------------------------------

# Hard rule kinds the toy model understands. These are *domain* names. A second
# solver implementing the same port would translate the same set.
RULE_ONE_ASSIGNMENT_PER_STAFF_PER_DAY = "AT_MOST_ONE_ASSIGNMENT_PER_STAFF_PER_DAY"
RULE_DEMAND_FULFILMENT = "DEMAND_FULFILMENT"
RULE_ELIGIBILITY = "ELIGIBILITY"
RULE_FORBIDDEN_SHIFT_SEQUENCE = "FORBIDDEN_SHIFT_SEQUENCE"
RULE_MAX_ASSIGNMENTS_PER_STAFF = "MAX_ASSIGNMENTS_PER_STAFF"

KNOWN_HARD_RULE_KINDS = frozenset(
    {
        RULE_ONE_ASSIGNMENT_PER_STAFF_PER_DAY,
        RULE_DEMAND_FULFILMENT,
        RULE_ELIGIBILITY,
        RULE_FORBIDDEN_SHIFT_SEQUENCE,
        RULE_MAX_ASSIGNMENTS_PER_STAFF,
    }
)

OBJECTIVE_FTE_TARGET_DEVIATION = "FTE_TARGET_DEVIATION"
KNOWN_OBJECTIVE_KINDS = frozenset({OBJECTIVE_FTE_TARGET_DEVIATION})

# Solver-neutral outcome vocabulary. The adapter maps the solver's own status
# enum onto exactly these; the rest of the platform never sees a solver enum.
# SPEC-04 §2: FEASIBLE and UNKNOWN are never collapsed into "done".
STATUS_OPTIMAL = "OPTIMAL"
STATUS_FEASIBLE = "FEASIBLE"
STATUS_INFEASIBLE = "INFEASIBLE"
STATUS_UNKNOWN = "UNKNOWN"
STATUS_MODEL_INVALID = "MODEL_INVALID"
STATUS_ERROR = "ERROR"

# SPEC-04 §2: termination_reason ∈ {deadline, user_cancelled, killed, crashed}
# plus the ordinary completion case.
TERMINATION_COMPLETED = "completed"
TERMINATION_DEADLINE = "deadline"
TERMINATION_USER_CANCELLED = "user_cancelled"
TERMINATION_CRASHED = "crashed"
# "killed" is never self-reported: a SIGKILLed worker writes nothing. The
# parent attributes it. Recorded here so the vocabulary is complete in one place.
TERMINATION_KILLED = "killed"


class ProtocolError(Exception):
    """Malformed or unsupported request. Rejected, never guessed at."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Canonical JSON — determinism depends on this
# ---------------------------------------------------------------------------


def canonical_dumps(obj: Any) -> str:
    """Byte-stable JSON: sorted keys, fixed separators, no NaN, ASCII-escaped.

    H-6 compares solution bytes across runs. Without canonicalisation the
    comparison would measure dict ordering, not solver determinism.
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


# ---------------------------------------------------------------------------
# Structural validation (hand-rolled: no third-party schema dependency in the
# worker image beyond the solver itself)
# ---------------------------------------------------------------------------


def _require(cond: bool, code: str, message: str) -> None:
    if not cond:
        raise ProtocolError(code, message)


def _req_key(d: Dict[str, Any], key: str, types: tuple, where: str) -> Any:
    _require(isinstance(d, dict), "not_an_object", "%s must be an object" % where)
    _require(key in d, "missing_field", "%s.%s is required" % (where, key))
    value = d[key]
    _require(
        isinstance(value, types),
        "bad_type",
        "%s.%s has wrong type (%s)" % (where, key, type(value).__name__),
    )
    return value


def validate_request(req: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a SolveRequest envelope. Raises ProtocolError, never guesses."""
    _require(isinstance(req, dict), "not_an_object", "request must be a JSON object")

    version = _req_key(req, "protocol_version", (int,), "request")
    _require(
        version in SUPPORTED_PROTOCOL_VERSIONS,
        "unsupported_protocol_version",
        "protocol_version %s not in supported window %s"
        % (version, list(SUPPORTED_PROTOCOL_VERSIONS)),
    )

    message_type = _req_key(req, "message_type", (str,), "request")
    _require(
        message_type == "SolveRequest",
        "unsupported_message_type",
        "message_type %r is not handled by this worker" % message_type,
    )

    # Authenticated-call placeholder: shape is enforced, credential is not
    # verified in the spike.
    auth = _req_key(req, "auth", (dict,), "request")
    _req_key(auth, "scheme", (str,), "request.auth")
    _require("principal" in auth, "missing_field", "request.auth.principal is required")
    _require("credential" in auth, "missing_field", "request.auth.credential is required")

    context = _req_key(req, "context", (dict,), "request")
    for field in ("organization_id", "group_id", "build_run_id", "correlation_id"):
        _req_key(context, field, (str,), "request.context")

    params = _req_key(req, "solve_parameters", (dict,), "request")
    _req_key(params, "random_seed", (int,), "request.solve_parameters")
    _req_key(params, "num_search_workers", (int,), "request.solve_parameters")
    _req_key(params, "max_time_in_seconds", (int, float), "request.solve_parameters")

    _require("control" in req, "missing_field", "request.control is required")
    _require(
        isinstance(req["control"], dict),
        "bad_type",
        "request.control must be an object",
    )

    problem = _req_key(req, "problem", (dict,), "request")
    validate_problem(problem)
    return req


def validate_problem(problem: Dict[str, Any]) -> Dict[str, Any]:
    """Validate the solver-neutral problem document."""
    schema_version = _req_key(problem, "problem_schema_version", (str,), "problem")
    _require(
        schema_version in SUPPORTED_PROBLEM_SCHEMA_VERSIONS,
        "unsupported_problem_schema_version",
        "problem_schema_version %r not in supported window %s"
        % (schema_version, list(SUPPORTED_PROBLEM_SCHEMA_VERSIONS)),
    )
    _req_key(problem, "problem_id", (str,), "problem")

    horizon = _req_key(problem, "horizon", (dict,), "problem")
    days = _req_key(horizon, "days", (int,), "problem.horizon")
    _require(days > 0, "bad_value", "problem.horizon.days must be positive")

    shift_types = _req_key(problem, "shift_types", (list,), "problem")
    _require(len(shift_types) > 0, "bad_value", "problem.shift_types must be non-empty")
    shift_ids = set()
    for st in shift_types:
        sid = _req_key(st, "id", (str,), "problem.shift_types[]")
        _require(sid not in shift_ids, "duplicate_id", "duplicate shift_type id %r" % sid)
        shift_ids.add(sid)

    staff = _req_key(problem, "staff", (list,), "problem")
    _require(len(staff) > 0, "bad_value", "problem.staff must be non-empty")
    staff_ids = set()
    for member in staff:
        mid = _req_key(member, "id", (str,), "problem.staff[]")
        _require(mid not in staff_ids, "duplicate_id", "duplicate staff id %r" % mid)
        staff_ids.add(mid)
        fte = _req_key(member, "fte_basis_points", (int,), "problem.staff[]")
        _require(0 <= fte <= 10000, "bad_value", "fte_basis_points out of range for %s" % mid)
        eligible = _req_key(member, "eligible_shift_type_ids", (list,), "problem.staff[]")
        for sid in eligible:
            _require(
                sid in shift_ids,
                "unknown_reference",
                "staff %s eligible for unknown shift_type %r" % (mid, sid),
            )

    demand = _req_key(problem, "demand", (list,), "problem")
    for cell in demand:
        day = _req_key(cell, "day_index", (int,), "problem.demand[]")
        _require(0 <= day < days, "bad_value", "demand.day_index %s out of horizon" % day)
        sid = _req_key(cell, "shift_type_id", (str,), "problem.demand[]")
        _require(
            sid in shift_ids,
            "unknown_reference",
            "demand references unknown shift_type %r" % sid,
        )
        _req_key(cell, "required", (int,), "problem.demand[]")
        mode = _req_key(cell, "mode", (str,), "problem.demand[]")
        _require(
            mode in ("exact", "at_least"),
            "bad_value",
            "demand.mode %r must be 'exact' or 'at_least'" % mode,
        )

    hard_rules = _req_key(problem, "hard_rules", (list,), "problem")
    for rule in hard_rules:
        _req_key(rule, "rule_id", (str,), "problem.hard_rules[]")
        kind = _req_key(rule, "kind", (str,), "problem.hard_rules[]")
        # E1's "unmapped node fails CI" discipline, applied early: an unknown
        # rule kind is rejected, never silently dropped.
        _require(
            kind in KNOWN_HARD_RULE_KINDS,
            "unmapped_rule_kind",
            "hard rule kind %r is not mapped by this worker" % kind,
        )
        classification = _req_key(rule, "classification", (str,), "problem.hard_rules[]")
        _require(
            classification == "HARD",
            "bad_value",
            "hard_rules entries must be classified HARD",
        )

    soft_objectives = _req_key(problem, "soft_objectives", (list,), "problem")
    for obj in soft_objectives:
        _req_key(obj, "objective_id", (str,), "problem.soft_objectives[]")
        kind = _req_key(obj, "kind", (str,), "problem.soft_objectives[]")
        _require(
            kind in KNOWN_OBJECTIVE_KINDS,
            "unmapped_objective_kind",
            "objective kind %r is not mapped by this worker" % kind,
        )
        _req_key(obj, "weight", (int,), "problem.soft_objectives[]")

    return problem


def hard_rule(problem: Dict[str, Any], kind: str) -> Optional[Dict[str, Any]]:
    for rule in problem["hard_rules"]:
        if rule["kind"] == kind:
            return rule
    return None


def hard_rules(problem: Dict[str, Any], kind: str) -> List[Dict[str, Any]]:
    return [r for r in problem["hard_rules"] if r["kind"] == kind]


def error_response(
    request: Optional[Dict[str, Any]],
    code: str,
    message: str,
    termination_reason: str = TERMINATION_CRASHED,
) -> Dict[str, Any]:
    context = {}
    if isinstance(request, dict) and isinstance(request.get("context"), dict):
        context = request["context"]
    return {
        "protocol_version": PROTOCOL_VERSION,
        "message_type": "SolveResponse",
        "context": context,
        "status": STATUS_ERROR,
        "termination_reason": termination_reason,
        "error": {"code": code, "message": message},
        "solution": None,
        "reproducibility": None,
    }
