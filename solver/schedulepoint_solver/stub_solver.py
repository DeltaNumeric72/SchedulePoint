"""The **stub** solve — doc 35 §6a, "stub solver first".

    Stub first: a stub solver returning a fixed valid candidate proves the full
    round trip, auth, timeout, cancellation, and forced-kill paths before any
    real constraint model exists.

That ordering is the packet's, and it is the right way round. The expensive,
subtle, security-relevant parts of a second-language boundary are the boundary:
does the request authenticate, is the protocol version enforced, does a cancel
actually stop the solve, does a wedged process die, is a killed run reported as
killed. None of those needs a constraint model, and every one of them is harder
to test once a constraint model is in the way. **M4-002 replaces this module
with the CP-SAT adapter; nothing else in the worker changes.**

## What the stub is, exactly

A deterministic greedy fill. It walks the demand cells in canonical order and
assigns the eligible participants the snapshot already marked eligible, in
canonical order, without repeating a participant on a day. It is a *feasible-shaped
candidate generator*, not an optimiser, and it makes no claim it cannot support:

* **It never reports ``OPTIMAL``.** Optimality is a proof, and this has none.
  SPEC-04 §7's rule — no optimality claim for a feasible result — is not
  something to start violating in the stub and fix later.
* **It never reports ``INFEASIBLE``.** Failing to fill demand greedily is not a
  proof that nothing fills it. Unfilled demand is ``UNKNOWN``: "I stopped without
  deciding", which is exactly what happened.

## The three behaviours, and why a stub has any

``control.stubBehaviour`` selects among them. They exist because the packet's
test list requires a *measured* timeout kill, an *honest* mid-solve cancellation,
and a forced termination that leaves no orphan — and none of those can be
exercised against a solve that returns in a millisecond.

``candidate``  return immediately. The ordinary round trip.
``dwell``      run for ``control.stubDwellMs``, checking the cancellation flag
               every tick. Cancelled -> ``CANCELLED``/``user_cancelled``.
               Not cancelled -> ``TIMEOUT``/``deadline`` if the parameter budget
               is reached, else the candidate.
``wedged``     ignore the flag and the budget entirely. **This is SPEC-04 §2's
               mechanism 3 subject**: the case where layers 1 and 2 do not
               return, and the only thing that ends the solve is the parent
               terminating the subprocess. A boundary that cannot be tested
               against a wedged solve is a boundary whose kill path has never
               run.

``wedged`` is a deliberate hazard and is named as one. It is reachable only from
an authenticated request that asks for it by name, and the real adapter will not
carry it.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List

from . import protocol as P
from .cancellation import CancelChannel

#: Poll granularity for ``dwell``. Small enough that a cancellation observed by
#: the watcher thread is acted on well inside the 17 ms the spike measured for
#: the mechanism it stands in for.
_TICK_SECONDS = 0.005

BEHAVIOUR_CANDIDATE = "candidate"
BEHAVIOUR_DWELL = "dwell"
BEHAVIOUR_WEDGED = "wedged"
BEHAVIOURS = (BEHAVIOUR_CANDIDATE, BEHAVIOUR_DWELL, BEHAVIOUR_WEDGED)


def _eligible_participants(snapshot: Dict[str, Any], shift_type_id: str) -> List[str]:
    """Participants the SNAPSHOT already judged eligible for this shift type.

    The worker does **not** re-derive eligibility, and that is a boundary rule
    rather than a shortcut. The one eligibility verdict lives in
    ``packages/domain/src/eligibility`` (frozen, doc 34 §4-B) and is evaluated
    during assembly; a second implementation here would be the S-01 defect shape
    across a language boundary, where the two copies could not even be compared
    by a scanner. The snapshot carries the verdict; the worker consumes it.
    """
    eligible: List[str] = []
    for participant in snapshot.get("participants", []):
        membership_id = participant.get("membershipId")
        if not isinstance(membership_id, str):
            continue
        for verdict in participant.get("eligibility", []):
            if verdict.get("shiftTypeId") == shift_type_id and verdict.get("eligible") is True:
                eligible.append(membership_id)
                break
    eligible.sort()
    return eligible


def _demand_cells(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Dated demand, in a total order, so two runs cannot differ by iteration.

    Only ``period-requirement`` cells are consumed: they name a real date.
    Weekday defaults are the catalogue's template for generating requirements and
    are carried in the snapshot for the record and for M4-002's model, not to be
    solved directly — expanding them here would invent requirement rows that the
    period does not have.
    """
    cells = [
        cell
        for cell in snapshot.get("demand", [])
        if cell.get("source") == "period-requirement"
    ]
    cells.sort(key=lambda cell: (str(cell.get("on")), str(cell.get("shiftTypeId"))))
    return cells


def _location_for(snapshot: Dict[str, Any], shift_type_id: str) -> Any:
    """A stub does not choose locations; it carries through the fixed ones."""
    for fixed in snapshot.get("fixedAssignments", []):
        if fixed.get("shiftTypeId") == shift_type_id:
            return fixed.get("locationId")
    return None


def build_candidate(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """The deterministic greedy fill. Pure over the snapshot; no clock, no random.

    Determinism here is not decoration: the round-trip proof compares the
    canonical response bytes across runs, and a candidate that depended on dict
    iteration order would make that comparison measure Python's hashing rather
    than the boundary.
    """
    assignments: List[Dict[str, Any]] = []
    taken = set()  # (membershipId, date) — nobody works two shifts in one day
    unfilled = 0

    # Fixed inputs first: a pin is an input, not a suggestion. SPEC-04 §6 —
    # a progressive build's fixed inputs are recorded rather than inferred, and
    # a stub that dropped them would make "protected" mean nothing.
    for fixed in sorted(
        snapshot.get("fixedAssignments", []),
        key=lambda f: (str(f.get("date")), str(f.get("shiftTypeId")), str(f.get("membershipId"))),
    ):
        membership_id = fixed.get("membershipId")
        date = fixed.get("date")
        assignments.append(
            {
                "membershipId": membership_id,
                "date": date,
                "shiftTypeId": fixed.get("shiftTypeId"),
                "locationId": fixed.get("locationId"),
            }
        )
        taken.add((membership_id, date))

    for cell in _demand_cells(snapshot):
        date = str(cell.get("on"))
        shift_type_id = str(cell.get("shiftTypeId"))
        required = cell.get("requiredCount")
        if not isinstance(required, int):
            continue
        already = sum(
            1
            for a in assignments
            if a["date"] == date and a["shiftTypeId"] == shift_type_id
        )
        candidates = _eligible_participants(snapshot, shift_type_id)
        for membership_id in candidates:
            if already >= required:
                break
            if (membership_id, date) in taken:
                continue
            assignments.append(
                {
                    "membershipId": membership_id,
                    "date": date,
                    "shiftTypeId": shift_type_id,
                    "locationId": _location_for(snapshot, shift_type_id),
                }
            )
            taken.add((membership_id, date))
            already += 1
        if already < required:
            unfilled += required - already

    assignments.sort(
        key=lambda a: (a["date"], a["shiftTypeId"], a["membershipId"])
    )
    return {"assignments": assignments, "unfilled": unfilled}


def solve(
    snapshot: Dict[str, Any],
    parameters: Dict[str, Any],
    control: Dict[str, Any],
    channel: CancelChannel,
) -> Dict[str, Any]:
    """Run the stub, honouring cancellation and the deadline honestly."""
    behaviour = control.get("stubBehaviour", BEHAVIOUR_CANDIDATE)
    if behaviour not in BEHAVIOURS:
        raise P.ProtocolError(
            "unknown_stub_behaviour",
            "control.stubBehaviour %r is not one of %s" % (behaviour, list(BEHAVIOURS)),
        )

    if behaviour == BEHAVIOUR_WEDGED:
        # Layers 1 and 2 deliberately do not return. The parent's termination is
        # the only thing that ends this, which is the property SPEC-04 §2 calls
        # "what makes cancellation a guarantee rather than a hope".
        while True:  # pragma: no cover - the process is killed inside this loop
            time.sleep(_TICK_SECONDS)

    if behaviour == BEHAVIOUR_DWELL:
        dwell_ms = control.get("stubDwellMs", 0)
        if not isinstance(dwell_ms, int) or isinstance(dwell_ms, bool) or dwell_ms < 0:
            raise P.ProtocolError("bad_value", "control.stubDwellMs must be a non-negative integer")
        budget_seconds = float(parameters["maxTimeInSeconds"])
        started = time.monotonic()
        deadline = started + budget_seconds
        finish_at = started + (dwell_ms / 1000.0)
        while time.monotonic() < finish_at:
            if channel.is_cancelled():
                # The H-6 finding, honoured: a cancelled solve is CANCELLED. It
                # is not reported as a timeout because a timeout is a different
                # thing that a scheduler would respond to differently.
                return {
                    "status": P.STATUS_CANCELLED,
                    "terminationReason": P.TERMINATION_USER_CANCELLED,
                    "assignments": None,
                    "unfilled": None,
                }
            if time.monotonic() >= deadline:
                # The solver-native deadline, layer 1. No incumbent to report,
                # so TIMEOUT rather than FEASIBLE.
                return {
                    "status": P.STATUS_TIMEOUT,
                    "terminationReason": P.TERMINATION_DEADLINE,
                    "assignments": None,
                    "unfilled": None,
                }
            time.sleep(_TICK_SECONDS)

    result = build_candidate(snapshot)
    if result["unfilled"] > 0:
        # Greedy failure is not a proof of infeasibility, and claiming one would
        # send a scheduler to rewrite rules that are fine.
        return {
            "status": P.STATUS_UNKNOWN,
            "terminationReason": P.TERMINATION_COMPLETED,
            "assignments": result["assignments"],
            "unfilled": result["unfilled"],
        }
    return {
        "status": P.STATUS_FEASIBLE,
        "terminationReason": P.TERMINATION_COMPLETED,
        "assignments": result["assignments"],
        "unfilled": 0,
    }
