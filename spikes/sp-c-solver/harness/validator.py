"""Independent re-validator. Reads the problem and the solution; imports no solver.

SPIKE CODE — SP-C / SP-5.

This is the acceptance instrument for `hard_violations = 0`. It deliberately
**re-implements** the semantics of every hard rule and of the FTE objective from
the problem document rather than importing ``worker.cpsat_adapter``. If it
shared code with the adapter it would confirm the adapter agrees with itself,
which is not a check.

It must never import ``ortools``. H-0 asserts that mechanically.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from typing import Any, Dict, List

FTE_SCALE = 1000  # re-declared, not imported — see module docstring


def validate(problem: Dict[str, Any], solution: Dict[str, Any]) -> Dict[str, Any]:
    violations: List[Dict[str, Any]] = []

    def violate(rule_id: str, kind: str, detail: str, **extra: Any) -> None:
        entry = {"rule_id": rule_id, "kind": kind, "detail": detail}
        entry.update(extra)
        violations.append(entry)

    days = problem["horizon"]["days"]
    shift_ids = {s["id"] for s in problem["shift_types"]}
    staff_by_id = {s["id"]: s for s in problem["staff"]}
    rules_by_kind = defaultdict(list)
    for rule in problem["hard_rules"]:
        rules_by_kind[rule["kind"]].append(rule)

    assignments = solution["assignments"]

    # --- structural integrity of the solution document ---------------------
    seen = set()
    for a in assignments:
        key = (a["staff_id"], a["day_index"], a["shift_type_id"])
        if key in seen:
            violate("STRUCT", "DUPLICATE_ASSIGNMENT", "assignment repeated: %s" % (key,))
        seen.add(key)
        if a["staff_id"] not in staff_by_id:
            violate("STRUCT", "UNKNOWN_STAFF", "unknown staff_id %r" % a["staff_id"])
        if a["shift_type_id"] not in shift_ids:
            violate("STRUCT", "UNKNOWN_SHIFT", "unknown shift_type_id %r" % a["shift_type_id"])
        if not (0 <= a["day_index"] < days):
            violate("STRUCT", "DAY_OUT_OF_HORIZON", "day_index %s" % a["day_index"])

    if solution.get("assignment_count") != len(assignments):
        violate(
            "STRUCT",
            "COUNT_MISMATCH",
            "assignment_count %s != len(assignments) %s"
            % (solution.get("assignment_count"), len(assignments)),
        )

    by_staff_day: Dict[Any, List[str]] = defaultdict(list)
    by_cell: Dict[Any, int] = defaultdict(int)
    per_staff_total: Dict[str, int] = defaultdict(int)
    staff_day_shift = set()
    for a in assignments:
        by_staff_day[(a["staff_id"], a["day_index"])].append(a["shift_type_id"])
        by_cell[(a["day_index"], a["shift_type_id"])] += 1
        per_staff_total[a["staff_id"]] += 1
        staff_day_shift.add((a["staff_id"], a["day_index"], a["shift_type_id"]))

    # --- HARD: eligibility --------------------------------------------------
    for rule in rules_by_kind.get("ELIGIBILITY", []):
        for a in assignments:
            member = staff_by_id.get(a["staff_id"])
            if member and a["shift_type_id"] not in member["eligible_shift_type_ids"]:
                violate(
                    rule["rule_id"],
                    "ELIGIBILITY",
                    "%s is not eligible for %s (day %d)"
                    % (a["staff_id"], a["shift_type_id"], a["day_index"]),
                )

    # --- HARD: at most one assignment per staff per day --------------------
    for rule in rules_by_kind.get("AT_MOST_ONE_ASSIGNMENT_PER_STAFF_PER_DAY", []):
        for (sid, d), shifts in sorted(by_staff_day.items()):
            if len(shifts) > 1:
                violate(
                    rule["rule_id"],
                    "AT_MOST_ONE_ASSIGNMENT_PER_STAFF_PER_DAY",
                    "%s has %d assignments on day %d: %s"
                    % (sid, len(shifts), d, sorted(shifts)),
                )

    # --- HARD: demand fulfilment -------------------------------------------
    for rule in rules_by_kind.get("DEMAND_FULFILMENT", []):
        for cell in problem["demand"]:
            got = by_cell.get((cell["day_index"], cell["shift_type_id"]), 0)
            need = cell["required"]
            ok = got == need if cell["mode"] == "exact" else got >= need
            if not ok:
                violate(
                    rule["rule_id"],
                    "DEMAND_FULFILMENT",
                    "day %d %s: filled %d, required %d (%s)"
                    % (cell["day_index"], cell["shift_type_id"], got, need, cell["mode"]),
                )

    # --- HARD: forbidden shift sequence (spacing) --------------------------
    for rule in rules_by_kind.get("FORBIDDEN_SHIFT_SEQUENCE", []):
        gap = rule["params"].get("gap_days", 1)
        for transition in rule["params"]["transitions"]:
            f = transition["from_shift_type_id"]
            for to in transition["to_shift_type_ids"]:
                for sid in staff_by_id:
                    for d in range(days - gap):
                        if (sid, d, f) in staff_day_shift and (
                            sid,
                            d + gap,
                            to,
                        ) in staff_day_shift:
                            violate(
                                rule["rule_id"],
                                "FORBIDDEN_SHIFT_SEQUENCE",
                                "%s works %s on day %d then %s on day %d"
                                % (sid, f, d, to, d + gap),
                            )

    # --- HARD: maximum assignments per staff --------------------------------
    for rule in rules_by_kind.get("MAX_ASSIGNMENTS_PER_STAFF", []):
        default_max = rule["params"].get("default_max")
        for sid, member in sorted(staff_by_id.items()):
            cap = member.get("max_assignments", default_max)
            if cap is None:
                continue
            if per_staff_total.get(sid, 0) > cap:
                violate(
                    rule["rule_id"],
                    "MAX_ASSIGNMENTS_PER_STAFF",
                    "%s has %d assignments, cap %d" % (sid, per_staff_total[sid], cap),
                )

    # --- SOFT: recompute the FTE objective independently -------------------
    total_required = sum(c["required"] for c in problem["demand"])
    fte_sum = sum(s["fte_basis_points"] for s in problem["staff"])
    targets = {}
    for member in problem["staff"]:
        numerator = total_required * member["fte_basis_points"] * FTE_SCALE
        targets[member["id"]] = (numerator + fte_sum // 2) // fte_sum

    objective = 0
    for obj in problem["soft_objectives"]:
        if obj["kind"] != "FTE_TARGET_DEVIATION":
            continue
        for sid in staff_by_id:
            objective += obj["weight"] * abs(
                per_staff_total.get(sid, 0) * FTE_SCALE - targets[sid]
            )

    # Cross-check the worker's echoed targets against ours. Drift here would
    # mean the adapter and the validator disagree about what the problem says.
    echoed = solution.get("fte_targets_scaled") or {}
    if echoed and echoed != targets:
        differing = sorted(k for k in set(echoed) | set(targets) if echoed.get(k) != targets.get(k))
        violate(
            "STRUCT",
            "FTE_TARGET_DRIFT",
            "worker and validator disagree on FTE targets for %s" % differing[:5],
        )

    return {
        "hard_violations": len(violations),
        "violations": violations,
        "recomputed_objective_value": objective,
        "assignment_count": len(assignments),
        "assignments_per_staff": dict(sorted(per_staff_total.items())),
        "fte_targets_scaled": targets,
        "total_required": total_required,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="independent solution re-validator")
    parser.add_argument("problem")
    parser.add_argument("response", help="SolveResponse JSON (or a bare solution doc)")
    args = parser.parse_args()
    problem = json.load(open(args.problem))
    doc = json.load(open(args.response))
    solution = doc.get("solution", doc)
    if solution is None:
        print("no solution in response (status=%s)" % doc.get("status"))
        return 1
    report = validate(problem, solution)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["hard_violations"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
