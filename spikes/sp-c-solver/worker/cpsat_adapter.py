"""The ONLY module in this spike that may import OR-Tools.

SPIKE CODE — SP-C / SP-5.

Everything on the far side of this file — the protocol, the harness, the
re-validator, the problem generator — is solver-neutral. If CP-SAT were swapped
for a MIP or a hybrid, this file is the file that would be rewritten and the
only one. `harness/run_harness.py` case H-0 asserts that mechanically.

Responsibilities
----------------
* translate the solver-neutral problem into a CP-SAT model (integers only — no
  floating point enters the model; FTE targets are scaled to basis points)
* apply the recorded parameter set (seed, worker count, deadline)
* run the solve under a cooperative cancellation callback
* map CP-SAT's status enum onto the platform's solver-neutral vocabulary
* return a reproducibility record (report 21 §7)
"""

from __future__ import annotations

import platform
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from ortools.sat.python import cp_model

from . import protocol as P
from .cancellation import CancelChannel

# Integer scaling factor for the FTE-target objective. The model is solved
# entirely in integers; this is the "integer scaling decision" made explicit.
FTE_SCALE = 1000


def _pkg_version() -> str:
    try:
        import importlib.metadata as md  # py3.8+

        return md.version("ortools")
    except Exception:  # pragma: no cover
        return "unknown"


# ---------------------------------------------------------------------------
# Status mapping — SPEC-04 §2. FEASIBLE and UNKNOWN are never collapsed.
# ---------------------------------------------------------------------------

_STATUS_MAP = {
    cp_model.OPTIMAL: P.STATUS_OPTIMAL,
    cp_model.FEASIBLE: P.STATUS_FEASIBLE,
    cp_model.INFEASIBLE: P.STATUS_INFEASIBLE,
    cp_model.MODEL_INVALID: P.STATUS_MODEL_INVALID,
    cp_model.UNKNOWN: P.STATUS_UNKNOWN,
}


class _CancelCallback(cp_model.CpSolverSolutionCallback):
    """Layer-2 cooperative cancellation: checked on every improving solution."""

    def __init__(self, channel: CancelChannel):
        cp_model.CpSolverSolutionCallback.__init__(self)
        self._channel = channel
        self.solution_count = 0
        self.first_solution_at: Optional[float] = None
        self.stop_requested_at: Optional[float] = None

    def on_solution_callback(self) -> None:
        self.solution_count += 1
        if self.first_solution_at is None:
            self.first_solution_at = time.monotonic()
        if self._channel.is_cancelled():
            self._channel.mark_acted()
            self.stop_requested_at = time.monotonic()
            self.StopSearch()


class _Model:
    """Built CP-SAT model plus the index needed to read a solution back out."""

    def __init__(self) -> None:
        self.model = cp_model.CpModel()
        self.x: Dict[Tuple[str, int, str], Any] = {}
        self.assumption_labels: Dict[int, str] = {}
        self.staff_ids: List[str] = []
        self.shift_ids: List[str] = []
        self.days: int = 0
        self.fte_targets_scaled: Dict[str, int] = {}
        self.build_seconds: float = 0.0
        self.objective_enabled: bool = False


def build_model(
    problem: Dict[str, Any],
    use_assumptions: bool = False,
    assumption_granularity: str = "instance",
    assumption_rule_ids: Optional[List[str]] = None,
) -> _Model:
    """Translate the neutral problem document into CP-SAT.

    With ``use_assumptions`` each hard rule is reified behind an assumption
    literal so CP-SAT can report which subset was sufficient for infeasibility
    (explanation tier T1 probe, H-8). The objective is dropped in that mode:
    the probe is a feasibility question.

    ``assumption_granularity`` trades explanation resolution against solve cost:

    ``instance``  one literal per rule *instance* (this demand cell, this
                  staff-day spacing pair). Precise cores; every hard constraint
                  becomes reified, which can defeat presolve.
    ``rule``      one literal per rule. Cheap, but the core names rules, not
                  instances — a weaker explanation.

    ``assumption_rule_ids`` restricts reification to named rules; every other
    rule is posted as an ordinary hard constraint and keeps its presolve. That
    matters: reifying everything can turn an instant infeasibility proof into a
    timeout (H-8).
    """
    t0 = time.monotonic()
    built = _Model()
    m = built.model
    coarse = assumption_granularity == "rule"
    selected = set(assumption_rule_ids) if assumption_rule_ids else None
    _coarse_cache: Dict[str, Any] = {}

    days = problem["horizon"]["days"]
    shift_ids = [st["id"] for st in problem["shift_types"]]
    staff = problem["staff"]
    staff_ids = [s["id"] for s in staff]
    built.days, built.shift_ids, built.staff_ids = days, shift_ids, staff_ids

    def assume(label: str):
        """Create (or reuse) an assumption literal, register it, return it.

        Returns ``None`` when assumptions are off or this rule is not selected,
        in which case the caller posts the constraint unreified.
        """
        if not use_assumptions:
            return None
        if selected is not None and label.split(":", 1)[0] not in selected:
            return None
        if coarse:
            label = label.split(":", 1)[0]
            if label in _coarse_cache:
                return _coarse_cache[label]
        lit = m.NewBoolVar("A|" + label)
        m.AddAssumption(lit)
        built.assumption_labels[lit.Index()] = label
        if coarse:
            _coarse_cache[label] = lit
        return lit

    # --- decision variables -------------------------------------------------
    for sid in staff_ids:
        for d in range(days):
            for t in shift_ids:
                built.x[(sid, d, t)] = m.NewBoolVar("x|%s|%d|%s" % (sid, d, t))

    # --- HARD: eligibility --------------------------------------------------
    if P.hard_rule(problem, P.RULE_ELIGIBILITY) is not None:
        rule = P.hard_rule(problem, P.RULE_ELIGIBILITY)
        for member in staff:
            sid = member["id"]
            eligible = set(member["eligible_shift_type_ids"])
            forbidden = [t for t in shift_ids if t not in eligible]
            if not forbidden:
                continue
            terms = [built.x[(sid, d, t)] for d in range(days) for t in forbidden]
            lit = assume("%s:%s" % (rule["rule_id"], sid))
            if lit is not None:
                m.Add(sum(terms) == 0).OnlyEnforceIf(lit)
            else:
                m.Add(sum(terms) == 0)

    # --- HARD: at most one assignment per staff per day ---------------------
    rule = P.hard_rule(problem, P.RULE_ONE_ASSIGNMENT_PER_STAFF_PER_DAY)
    if rule is not None:
        for sid in staff_ids:
            for d in range(days):
                terms = [built.x[(sid, d, t)] for t in shift_ids]
                lit = assume("%s:%s:d%d" % (rule["rule_id"], sid, d))
                if lit is not None:
                    m.Add(sum(terms) <= 1).OnlyEnforceIf(lit)
                else:
                    m.AddAtMostOne(terms)

    # --- HARD: demand fulfilment -------------------------------------------
    rule = P.hard_rule(problem, P.RULE_DEMAND_FULFILMENT)
    if rule is not None:
        for cell in problem["demand"]:
            d = cell["day_index"]
            t = cell["shift_type_id"]
            required = cell["required"]
            terms = [built.x[(sid, d, t)] for sid in staff_ids]
            lit = assume("%s:d%d:%s" % (rule["rule_id"], d, t))
            expr = (
                sum(terms) == required
                if cell["mode"] == "exact"
                else sum(terms) >= required
            )
            if lit is not None:
                m.Add(expr).OnlyEnforceIf(lit)
            else:
                m.Add(expr)

    # --- HARD: forbidden shift sequence (the spacing constraint) ------------
    for rule in P.hard_rules(problem, P.RULE_FORBIDDEN_SHIFT_SEQUENCE):
        gap = rule["params"].get("gap_days", 1)
        for transition in rule["params"]["transitions"]:
            f = transition["from_shift_type_id"]
            to_list = transition["to_shift_type_ids"]
            for sid in staff_ids:
                for d in range(days - gap):
                    for t in to_list:
                        pair = [built.x[(sid, d, f)], built.x[(sid, d + gap, t)]]
                        lit = assume("%s:%s:d%d:%s>%s" % (rule["rule_id"], sid, d, f, t))
                        if lit is not None:
                            m.Add(sum(pair) <= 1).OnlyEnforceIf(lit)
                        else:
                            m.AddAtMostOne(pair)

    # --- HARD: maximum assignments per staff --------------------------------
    rule = P.hard_rule(problem, P.RULE_MAX_ASSIGNMENTS_PER_STAFF)
    if rule is not None:
        default_max = rule["params"].get("default_max")
        for member in staff:
            sid = member["id"]
            cap = member.get("max_assignments", default_max)
            if cap is None:
                continue
            terms = [built.x[(sid, d, t)] for d in range(days) for t in shift_ids]
            lit = assume("%s:%s" % (rule["rule_id"], sid))
            if lit is not None:
                m.Add(sum(terms) <= cap).OnlyEnforceIf(lit)
            else:
                m.Add(sum(terms) <= cap)

    # --- SOFT: FTE-target deviation ----------------------------------------
    built.fte_targets_scaled = compute_fte_targets_scaled(problem)
    objectives = problem["soft_objectives"]
    if objectives and not use_assumptions:
        penalty_terms = []
        for obj in objectives:
            if obj["kind"] != P.OBJECTIVE_FTE_TARGET_DEVIATION:
                raise ValueError("unmapped objective kind %r" % obj["kind"])
            weight = obj["weight"]
            total_slots = _total_required(problem)
            for member in staff:
                sid = member["id"]
                target = built.fte_targets_scaled[sid]
                assigned = sum(
                    built.x[(sid, d, t)] for d in range(days) for t in shift_ids
                )
                dev = m.NewIntVar(0, total_slots * FTE_SCALE, "dev|%s" % sid)
                m.Add(dev >= assigned * FTE_SCALE - target)
                m.Add(dev >= target - assigned * FTE_SCALE)
                penalty_terms.append(weight * dev)
        m.Minimize(sum(penalty_terms))
        built.objective_enabled = True

    built.build_seconds = time.monotonic() - t0
    return built


def _finite(value: float) -> Optional[float]:
    """JSON has no infinity. Non-finite parameter values are reported as null."""
    return float(value) if value == value and abs(value) != float("inf") else None


def _total_required(problem: Dict[str, Any]) -> int:
    return sum(cell["required"] for cell in problem["demand"])


def compute_fte_targets_scaled(problem: Dict[str, Any]) -> Dict[str, int]:
    """Per-staff target assignment count, scaled by FTE_SCALE.

    Deterministic integer arithmetic only — no float rounding, so the target is
    identical on every platform. Shared with the independent re-validator via
    the problem document, not by importing this module.
    """
    total = _total_required(problem)
    fte_sum = sum(s["fte_basis_points"] for s in problem["staff"])
    targets: Dict[str, int] = {}
    for member in problem["staff"]:
        numerator = total * member["fte_basis_points"] * FTE_SCALE
        targets[member["id"]] = (numerator + fte_sum // 2) // fte_sum
    return targets


def apply_parameters(solver: "cp_model.CpSolver", params: Dict[str, Any]) -> Dict[str, Any]:
    """Apply and then *read back* the effective parameter set.

    Read-back matters: the reproducibility record must state what the solver
    actually ran with, not what the caller asked for.
    """
    p = solver.parameters
    p.random_seed = int(params["random_seed"])
    p.num_search_workers = int(params["num_search_workers"])
    p.max_time_in_seconds = float(params["max_time_in_seconds"])
    p.log_search_progress = bool(params.get("log_search_progress", False))
    if "cp_model_presolve" in params:
        p.cp_model_presolve = bool(params["cp_model_presolve"])
    if "symmetry_level" in params:
        p.symmetry_level = int(params["symmetry_level"])
    # Deterministic parallelism. CP-SAT's default portfolio lets workers
    # exchange information whenever they happen to finish, which makes the
    # result depend on thread timing. interleave_search runs the portfolio in
    # deterministic batches instead. Measured in H-6b.
    if "interleave_search" in params:
        p.interleave_search = bool(params["interleave_search"])
    if params.get("max_deterministic_time") is not None:
        p.max_deterministic_time = float(params["max_deterministic_time"])
    return {
        "random_seed": p.random_seed,
        "num_search_workers": p.num_search_workers,
        "num_workers": p.num_workers,
        "max_time_in_seconds": _finite(p.max_time_in_seconds),
        # CP-SAT's default is +inf, which is not JSON. Reported as null.
        "max_deterministic_time": _finite(p.max_deterministic_time),
        "log_search_progress": p.log_search_progress,
        "cp_model_presolve": p.cp_model_presolve,
        "symmetry_level": p.symmetry_level,
        "interleave_search": p.interleave_search,
    }


def solve(
    problem: Dict[str, Any],
    params: Dict[str, Any],
    channel: CancelChannel,
    use_assumptions: bool = False,
    assumption_granularity: str = "instance",
    assumption_rule_ids: Optional[List[str]] = None,
    stop_via_thread: bool = False,
) -> Dict[str, Any]:
    """Build, solve, and translate the result back to neutral terms."""
    built = build_model(
        problem,
        use_assumptions=use_assumptions,
        assumption_granularity=assumption_granularity,
        assumption_rule_ids=assumption_rule_ids,
    )
    solver = cp_model.CpSolver()
    effective = apply_parameters(solver, params)

    callback = _CancelCallback(channel)

    watcher = None
    if stop_via_thread:
        watcher = _StopWatcher(solver, channel)
        watcher.start()

    t_start = time.monotonic()
    status = solver.Solve(built.model, callback)
    t_end = time.monotonic()

    if watcher is not None:
        watcher.stop()

    neutral_status = _STATUS_MAP.get(status, P.STATUS_UNKNOWN)
    wall = t_end - t_start

    deadline = float(params["max_time_in_seconds"])
    # The deadline is "reached" when the solver consumed essentially all of it
    # and did not prove optimality/infeasibility.
    deadline_reached = (
        neutral_status in (P.STATUS_FEASIBLE, P.STATUS_UNKNOWN)
        and solver.WallTime() >= deadline * 0.90
    )

    if channel.is_cancelled():
        termination = P.TERMINATION_USER_CANCELLED
    elif deadline_reached:
        termination = P.TERMINATION_DEADLINE
    else:
        termination = P.TERMINATION_COMPLETED

    solution = None
    if neutral_status in (P.STATUS_OPTIMAL, P.STATUS_FEASIBLE):
        solution = _extract_solution(problem, built, solver)

    sufficient = None
    if use_assumptions and neutral_status == P.STATUS_INFEASIBLE:
        indices = list(solver.SufficientAssumptionsForInfeasibility())
        sufficient = {
            "returned": True,
            "granularity": assumption_granularity,
            "selected_rule_ids": assumption_rule_ids,
            "count": len(indices),
            "assumption_count_total": len(built.assumption_labels),
            "labels": sorted(
                built.assumption_labels.get(i, "<unmapped:%d>" % i) for i in indices
            ),
        }
    elif use_assumptions:
        sufficient = {
            "returned": False,
            "granularity": assumption_granularity,
            "selected_rule_ids": assumption_rule_ids,
            "count": 0,
            "assumption_count_total": len(built.assumption_labels),
            "labels": [],
            "note": "status was %s, not INFEASIBLE" % neutral_status,
        }

    reproducibility = {
        "seed": effective["random_seed"],
        "num_search_workers": effective["num_search_workers"],
        "effective_num_workers": effective["num_workers"],
        "parameter_set": effective,
        "solver_family": "cp-sat",
        "ortools_version": _pkg_version(),
        "python_version": platform.python_version(),
        "python_implementation": platform.python_implementation(),
        "platform": "%s-%s" % (platform.system().lower(), platform.machine()),
        "model_build_seconds": round(built.build_seconds, 6),
        "solve_wall_seconds": round(wall, 6),
        "solver_reported_wall_seconds": round(solver.WallTime(), 6),
        "solver_user_seconds": round(solver.UserTime(), 6),
        "deterministic_time": round(solver.deterministic_time, 6),
        "num_branches": solver.NumBranches(),
        "num_conflicts": solver.NumConflicts(),
        "num_booleans": solver.NumBooleans(),
        "solution_callback_count": callback.solution_count,
        "raw_solver_status": solver.StatusName(status),
        "objective_enabled": built.objective_enabled,
        "objective_value": int(solver.ObjectiveValue())
        if built.objective_enabled and solution is not None
        else None,
        "best_objective_bound": int(solver.BestObjectiveBound())
        if built.objective_enabled and solution is not None
        else None,
    }

    cancellation = channel.report()
    cancellation.update(
        {
            "observed_at_offset_seconds": round(channel.observed_at - t_start, 6)
            if channel.observed_at is not None
            else None,
            "acted_at_offset_seconds": round(channel.acted_at - t_start, 6)
            if channel.acted_at is not None
            else None,
            "solve_returned_at_offset_seconds": round(wall, 6),
            "observed_to_return_seconds": round(t_end - channel.observed_at, 6)
            if channel.observed_at is not None
            else None,
            "acted_to_return_seconds": round(t_end - channel.acted_at, 6)
            if channel.acted_at is not None
            else None,
            "stop_path": "watcher_thread_stop_search"
            if stop_via_thread
            else "solution_callback",
        }
    )

    return {
        "status": neutral_status,
        "termination_reason": termination,
        "deadline_reached": deadline_reached,
        "solution": solution,
        "reproducibility": reproducibility,
        "cancellation": cancellation,
        "sufficient_assumptions": sufficient,
    }


class _StopWatcher:
    """Alternative layer-2 path: a thread calling CpSolver.stop_search().

    Not the packet's required mechanism — measured alongside it because the
    difference in latency is the interesting engineering fact.
    """

    def __init__(self, solver: "cp_model.CpSolver", channel: CancelChannel):
        self._solver = solver
        self._channel = channel
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run, name="stop-watcher", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            if self._channel.is_cancelled():
                self._channel.mark_acted()
                self._solver.StopSearch()
                return
            time.sleep(0.005)

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)


def _extract_solution(
    problem: Dict[str, Any], built: _Model, solver: "cp_model.CpSolver"
) -> Dict[str, Any]:
    """Read the solution out in neutral, canonically ordered terms."""
    assignments = []
    for sid in built.staff_ids:
        for d in range(built.days):
            for t in built.shift_ids:
                if solver.Value(built.x[(sid, d, t)]):
                    assignments.append(
                        {"staff_id": sid, "day_index": d, "shift_type_id": t}
                    )
    assignments.sort(key=lambda a: (a["staff_id"], a["day_index"], a["shift_type_id"]))

    counts: Dict[str, int] = {sid: 0 for sid in built.staff_ids}
    for a in assignments:
        counts[a["staff_id"]] += 1

    return {
        "solution_schema_version": P.SOLUTION_SCHEMA_VERSION,
        "problem_id": problem["problem_id"],
        "assignments": assignments,
        "assignment_count": len(assignments),
        "assignments_per_staff": counts,
        "fte_targets_scaled": built.fte_targets_scaled,
        "fte_scale": FTE_SCALE,
    }
