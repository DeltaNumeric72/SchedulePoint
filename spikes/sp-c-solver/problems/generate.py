"""Deterministic generator for the SP-C toy problems. No randomness, no solver.

SPIKE CODE — SP-C / SP-5.

Every instance is produced by an explicit formula so a reviewer can verify the
feasibility (or infeasibility) argument by reading, not by running. The
generated JSON is committed alongside this file; ``--check`` re-generates and
diffs to prove the committed documents match the generator.

Instances
---------
``toy-feasible``
    20 staff x 14 days x 3 shift types. 12 assignments/day = 168 total.
    Comfortably feasible: capacity 20x12 = 240 >= 168, night demand 3/day
    against 16 night-eligible staff, and the spacing rule removes at most 3
    staff from the following day's day-shift pool of 5.

``toy-infeasible-spacing``
    Alternating saturation. Even days require all 20 staff on ``night``; odd
    days require all 20 on ``day``. The spacing rule forbids night(d) -> day(d+1)
    for every staff member, so day 1 cannot be staffed at all.
    **Infeasible, and infeasible only because of the spacing rule** — which the
    control instance below demonstrates.

``toy-infeasible-spacing-control``
    Byte-identical to the above except the spacing rule is removed. Must solve.
    This is what turns "CP-SAT said INFEASIBLE" into "the model is infeasible".

``toy-infeasible-capacity``
    ``toy-feasible`` with a per-staff cap of 8. Capacity 20x8 = 160 < 168
    required. Pigeonhole; no search needed to see it.

``hard-large``
    60 staff x 60 days x 5 shift types (18,000 booleans). Feasible, but proving
    optimality of the FTE objective is not quick — used for the deadline and
    mid-solve cancellation cases.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from worker import protocol as P  # noqa: E402  (solver-neutral; no ortools)

# FTE mix, cycled across the roster. Basis points: 10000 = 1.0 FTE.
FTE_CYCLE = [10000, 10000, 8000, 10000, 6000, 10000, 8000, 4000, 10000, 6000]


def _staff(count: int, shift_ids: List[str], no_night_every: int = 5) -> List[Dict[str, Any]]:
    night = shift_ids[-1]
    roster = []
    for i in range(count):
        eligible = list(shift_ids)
        if no_night_every and i % no_night_every == (no_night_every - 1):
            eligible = [s for s in shift_ids if s != night]
        roster.append(
            {
                "id": "S%02d" % (i + 1),
                "display_name": "Staff %02d" % (i + 1),
                "fte_basis_points": FTE_CYCLE[i % len(FTE_CYCLE)],
                "eligible_shift_type_ids": eligible,
            }
        )
    return roster


def _shift_types(specs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {"id": s["id"], "label": s["label"], "ordinal": i, "high_burden": s["high_burden"]}
        for i, s in enumerate(specs)
    ]


TOY_SHIFTS = _shift_types(
    [
        {"id": "day", "label": "Day", "high_burden": False},
        {"id": "evening", "label": "Evening", "high_burden": False},
        {"id": "night", "label": "Night", "high_burden": True},
    ]
)


def _rule_eligibility() -> Dict[str, Any]:
    return {
        "rule_id": "HR-ELIG",
        "rule_key": "shift_type_eligibility",
        "name": "Staff may only work shift types they are eligible for",
        "rule_schema_version": "1.0.0",
        "classification": "HARD",
        "kind": P.RULE_ELIGIBILITY,
        "params": {},
    }


def _rule_one_per_day() -> Dict[str, Any]:
    return {
        "rule_id": "HR-ONEDAY",
        "rule_key": "at_most_one_shift_per_day",
        "name": "At most one shift per staff member per day",
        "rule_schema_version": "1.0.0",
        "classification": "HARD",
        "kind": P.RULE_ONE_ASSIGNMENT_PER_STAFF_PER_DAY,
        "params": {},
    }


def _rule_demand() -> Dict[str, Any]:
    return {
        "rule_id": "HR-DEMAND",
        "rule_key": "staffing_demand_fulfilment",
        "name": "Every demand cell must be filled as specified",
        "rule_schema_version": "1.0.0",
        "classification": "HARD",
        "kind": P.RULE_DEMAND_FULFILMENT,
        "params": {},
    }


def _rule_spacing(from_shift: str, to_shifts: List[str]) -> Dict[str, Any]:
    return {
        "rule_id": "HR-SPACING",
        "rule_key": "no_night_then_day",
        "name": "No %s shift immediately followed by %s"
        % (from_shift, "/".join(to_shifts)),
        "rule_schema_version": "1.0.0",
        "classification": "HARD",
        "kind": P.RULE_FORBIDDEN_SHIFT_SEQUENCE,
        "params": {
            "gap_days": 1,
            "transitions": [
                {"from_shift_type_id": from_shift, "to_shift_type_ids": list(to_shifts)}
            ],
        },
    }


def _rule_max_assignments(default_max: int) -> Dict[str, Any]:
    return {
        "rule_id": "HR-MAXASSIGN",
        "rule_key": "max_assignments_in_horizon",
        "name": "Maximum assignments per staff member across the horizon",
        "rule_schema_version": "1.0.0",
        "classification": "HARD",
        "kind": P.RULE_MAX_ASSIGNMENTS_PER_STAFF,
        "params": {"default_max": default_max},
    }


def _objective_fte() -> Dict[str, Any]:
    return {
        "objective_id": "SO-FTE",
        "objective_key": "fte_target_deviation",
        "name": "Distribute assignments in proportion to contracted FTE",
        "classification": "SOFT",
        "kind": P.OBJECTIVE_FTE_TARGET_DEVIATION,
        "weight": 1,
        "params": {
            "scale": 1000,
            "note": "target_scaled[s] = round(total_required * fte_bp[s] * scale / sum(fte_bp))",
        },
    }


def _envelope(problem_id: str, description: str, days: int, shift_types, staff, demand,
              hard_rules, soft_objectives) -> Dict[str, Any]:
    return {
        "problem_schema_version": P.PROBLEM_SCHEMA_VERSION,
        "problem_id": problem_id,
        "description": description,
        "horizon": {"days": days, "start_date": "2026-09-01", "timezone": "UTC"},
        "shift_types": shift_types,
        "staff": staff,
        "demand": demand,
        "hard_rules": hard_rules,
        "soft_objectives": soft_objectives,
    }


def toy_feasible() -> Dict[str, Any]:
    days = 14
    per_day = {"day": 5, "evening": 4, "night": 3}
    demand = [
        {"day_index": d, "shift_type_id": t, "required": per_day[t], "mode": "exact"}
        for d in range(days)
        for t in ("day", "evening", "night")
    ]
    return _envelope(
        "toy-feasible",
        "20 staff x 14 days x 3 shift types; 12 assignments/day; comfortably feasible",
        days,
        TOY_SHIFTS,
        _staff(20, ["day", "evening", "night"]),
        demand,
        [
            _rule_eligibility(),
            _rule_one_per_day(),
            _rule_demand(),
            _rule_spacing("night", ["day"]),
            _rule_max_assignments(12),
        ],
        [_objective_fte()],
    )


def toy_infeasible_spacing(with_spacing: bool = True) -> Dict[str, Any]:
    days = 14
    demand = []
    for d in range(days):
        night = 20 if d % 2 == 0 else 0
        day = 0 if d % 2 == 0 else 20
        demand.append({"day_index": d, "shift_type_id": "day", "required": day, "mode": "exact"})
        demand.append({"day_index": d, "shift_type_id": "evening", "required": 0, "mode": "exact"})
        demand.append({"day_index": d, "shift_type_id": "night", "required": night, "mode": "exact"})
    rules = [_rule_eligibility(), _rule_one_per_day(), _rule_demand()]
    if with_spacing:
        rules.append(_rule_spacing("night", ["day"]))
    pid = "toy-infeasible-spacing" if with_spacing else "toy-infeasible-spacing-control"
    desc = (
        "Alternating saturation: every staff member must work night on day 0 and "
        "day on day 1. The night->day rule forbids exactly that, for everyone."
        if with_spacing
        else "Identical to toy-infeasible-spacing with the spacing rule removed; "
        "must be feasible, proving the spacing rule is the sole cause."
    )
    return _envelope(
        pid,
        desc,
        days,
        TOY_SHIFTS,
        # Everyone eligible for everything: eligibility must not be the cause.
        _staff(20, ["day", "evening", "night"], no_night_every=0),
        demand,
        rules,
        [_objective_fte()],
    )


def toy_infeasible_capacity() -> Dict[str, Any]:
    problem = toy_feasible()
    problem["problem_id"] = "toy-infeasible-capacity"
    problem["description"] = (
        "toy-feasible with a per-staff cap of 8: capacity 20x8=160 < 168 required. "
        "Pigeonhole infeasibility."
    )
    for rule in problem["hard_rules"]:
        if rule["kind"] == P.RULE_MAX_ASSIGNMENTS_PER_STAFF:
            rule["params"]["default_max"] = 8
    return problem


HARD_SHIFTS = _shift_types(
    [
        {"id": "early", "label": "Early", "high_burden": False},
        {"id": "day", "label": "Day", "high_burden": False},
        {"id": "late", "label": "Late", "high_burden": False},
        {"id": "evening", "label": "Evening", "high_burden": False},
        {"id": "night", "label": "Night", "high_burden": True},
    ]
)


def hard_large() -> Dict[str, Any]:
    days = 60
    shift_ids = [s["id"] for s in HARD_SHIFTS]
    per_day = {"early": 10, "day": 8, "late": 6, "evening": 5, "night": 4}
    demand = [
        {"day_index": d, "shift_type_id": t, "required": per_day[t], "mode": "exact"}
        for d in range(days)
        for t in shift_ids
    ]
    return _envelope(
        "hard-large",
        "60 staff x 60 days x 5 shift types (18,000 booleans); feasible, but "
        "optimality of the FTE objective is not quick to prove",
        days,
        HARD_SHIFTS,
        _staff(60, shift_ids, no_night_every=4),
        demand,
        [
            _rule_eligibility(),
            _rule_one_per_day(),
            _rule_demand(),
            _rule_spacing("night", ["early", "day"]),
            _rule_max_assignments(45),
        ],
        [_objective_fte()],
    )


INSTANCES = {
    "toy-feasible": toy_feasible,
    "toy-infeasible-spacing": lambda: toy_infeasible_spacing(True),
    "toy-infeasible-spacing-control": lambda: toy_infeasible_spacing(False),
    "toy-infeasible-capacity": toy_infeasible_capacity,
    "hard-large": hard_large,
}


def path_for(name: str) -> str:
    return os.path.join(HERE, "%s.json" % name)


def render(name: str) -> str:
    problem = INSTANCES[name]()
    P.validate_problem(problem)
    return json.dumps(problem, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify committed files match")
    args = parser.parse_args()
    failures = 0
    for name in sorted(INSTANCES):
        text = render(name)
        target = path_for(name)
        if args.check:
            existing = open(target).read() if os.path.exists(target) else None
            if existing != text:
                print("DRIFT: %s does not match the generator" % target)
                failures += 1
            else:
                print("ok: %s" % os.path.basename(target))
        else:
            with open(target, "w") as fh:
                fh.write(text)
            print("wrote %s (%d bytes)" % (os.path.basename(target), len(text)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
