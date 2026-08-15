"""**The one module permitted to import OR-Tools** — ADR-0006, OPUS-M4-002.

The one-module allowance is deliberately spent here and nowhere else, and
``apps/api/test/solver/worker-invariants.test.ts`` scans this package and fails
the build on a second importer. Everything above this file speaks in problems,
statuses and assignments; only this file knows a constraint solver exists, which
is what keeps the engine replaceable behind the port.

## What this does, in order

1. build boolean cells ``x[membership, date, shift type]`` over the snapshot's
   own eligibility verdict;
2. make **demand satisfaction a hard equality** — SPEC-04 §7: a shortfall is a
   violation, not a metric;
3. translate every HARD rule to a constraint and every SOFT rule to an objective
   term, with **no path from HARD to an objective term** (SPEC-04 §3.3);
4. solve under the SPEC-04 §4 parameter set, with a watcher thread able to stop
   it;
5. on ``INFEASIBLE``, explain: T0 structural findings always, and a **budgeted,
   failable** T1 assumption solve for a conflicting subset.

## Cancellation, and why it is a thread

EV-M0-SPC H-4 measured the signal path at 28 s with a misreported outcome —
Python runs signal handlers only on the main thread and only while it is
executing bytecode, and during a native solve it is doing neither. The same
spike measured ``StopSearch()`` from a **watcher thread** at 17 ms. So the
watcher thread already running in ``cancellation.py`` is joined to the solver
here, and ``signal`` appears nowhere in this package (a test scans for it).

## The explanation tiers, and their honesty

SPEC-04 §5 promises T1 "an infeasible subset, **not necessarily minimal**", and
that is exactly what CP-SAT's ``SufficientAssumptionsForInfeasibility`` returns —
verified on this machine before a line of this was written (EV-M4-002 probe 02).
So a successful T1 reports ``EXPLAINED_SUBSET`` and never ``EXPLAINED_MINIMAL``:
minimisation is T2 and is M4-004's budget work. A T1 that exceeds its budget
reports ``EXPLANATION_BUDGET_EXCEEDED`` **with the T0 findings still attached**,
because "we could not isolate the cause in the time budget, here is what we do
know" is a better answer than a hang and an infinitely better one than a
confident guess.

**Blanket reification is not used.** The same spike measured it destroying
presolve outright (18.6 ms INFEASIBLE -> 90 s UNKNOWN), so the assumption model
is built as a SEPARATE solve, entered only when the ordinary one comes back
infeasible.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional, Tuple

from ortools.sat.python import cp_model

from . import model as M
from . import protocol as P
from .cancellation import CancelChannel


class _Built(object):
    """A model plus the bookkeeping needed to read a solution back out."""

    def __init__(self) -> None:
        self.model = cp_model.CpModel()
        self.cells = {}  # type: Dict[Tuple[str, str, str], Any]
        self.objective_tiers = []  # type: List[Dict[str, Any]]
        self.hard_rule_keys = []  # type: List[str]
        self.assumptions = {}  # type: Dict[str, Any]


def build(problem: M.Problem, rules: List[Dict[str, Any]], reify: bool) -> _Built:
    """Translate the problem. ``reify`` builds the T1 assumption model instead.

    One function for both, because two would drift: the T1 explanation must be
    about *the model that was infeasible*, and a separately written explanation
    model is a model that can disagree with the one it claims to explain.
    """
    built = _Built()
    m = built.model

    for cell in problem.cells():
        built.cells[cell] = m.NewBoolVar("x_%s_%s_%s" % cell)

    def cells_on(date, shift_type_id, memberships=None):
        return [
            built.cells[(membership_id, date, shift_type_id)]
            for membership_id in (memberships or problem.membership_ids)
            if (membership_id, date, shift_type_id) in built.cells
        ]

    def enforce(constraint, rule_key):
        """Post a HARD statement, behind an assumption literal in reify mode."""
        if not reify:
            return
        literal = built.assumptions.get(rule_key)
        if literal is None:
            literal = m.NewBoolVar("a_%s" % rule_key)
            built.assumptions[rule_key] = literal
        constraint.OnlyEnforceIf(literal)

    # ── demand: a HARD equality (SPEC-04 §7) ──────────────────────────────────
    # Absence of a requirement row means zero. The requirement rows are the
    # complete statement of what the period asks for, so a cell nothing asked
    # for must not be fillable — otherwise the solver could staff a day the
    # scheduler deliberately left empty.
    for date in problem.dates:
        for shift_type_id in problem.shift_type_ids:
            required = problem.required.get((date, shift_type_id), 0)
            variables = cells_on(date, shift_type_id)
            if not variables:
                if required > 0:
                    # Nobody is eligible and somebody is needed. Left as an
                    # explicit contradiction rather than raised: T0 names it, and
                    # a model that refused to be built could not be explained.
                    m.Add(0 == required)
                continue
            enforce(m.Add(sum(variables) == required), "__demand__")

    # ── fixed inputs: a pin is an input, not a suggestion ─────────────────────
    for fixed in problem.fixed:
        if not fixed.get("isPinned"):
            continue
        key = (
            str(fixed.get("membershipId")),
            str(fixed.get("date")),
            str(fixed.get("shiftTypeId")),
        )
        if key in built.cells:
            m.Add(built.cells[key] == 1)

    for rule in rules:
        classification, kind = M.classify(rule)
        rule_key = str(rule.get("ruleKey"))
        predicate = rule["predicate"]
        if classification == "HARD":
            built.hard_rule_keys.append(rule_key)
            _hard(built, problem, rule, rule_key, kind, predicate, cells_on, enforce)
        else:
            _soft(built, problem, rule, rule_key, kind, predicate)

    if built.objective_tiers and not reify:
        terms = []
        for tier in built.objective_tiers:
            terms.extend(tier["_terms"])
        if terms:
            m.Minimize(sum(terms))
    return built


# ---------------------------------------------------------------------------
# HARD -> constraints. One branch per ruling; every branch cites it.
# ---------------------------------------------------------------------------


def _hard(built, problem, rule, rule_key, kind, predicate, cells_on, enforce):
    m = built.model
    start, end = M.scope_window(rule, problem)
    window_dates = [d for d in problem.dates if start <= d <= end]

    def scoped(membership_id, date, shift_type_id):
        return M.scope_admits(rule, problem, membership_id, date, shift_type_id)

    def scoped_cells(membership_id=None, date=None, shift_type_id=None):
        out = []
        for key, var in built.cells.items():
            mid, d, sid = key
            if membership_id is not None and mid != membership_id:
                continue
            if date is not None and d != date:
                continue
            if shift_type_id is not None and sid != shift_type_id:
                continue
            if not scoped(mid, d, sid):
                continue
            out.append((key, var))
        return sorted(out, key=lambda pair: pair[0])

    def code_cells(membership_id, date, code):
        shift_type_id = problem.id_of_code.get(code)
        if shift_type_id is None:
            return []
        key = (membership_id, date, shift_type_id)
        if key not in built.cells or not scoped(*key):
            return []
        return [built.cells[key]]

    # ── RK-RULING-01: coverage counts over date × shift type ──────────────────
    if kind in ("RequiredCount", "MinCoverage", "MaxCoverage"):
        bound = predicate.get(
            "count" if kind == "RequiredCount" else ("min" if kind == "MinCoverage" else "max")
        )
        codes = (rule.get("scope") or {}).get("shiftTypes") or [
            problem.code_of[i] for i in problem.shift_type_ids
        ]
        for date in window_dates:
            for code in sorted(str(c) for c in codes):
                shift_type_id = problem.id_of_code.get(code)
                if shift_type_id is None:
                    continue
                variables = [
                    var
                    for _, var in scoped_cells(date=date, shift_type_id=shift_type_id)
                ]
                total = sum(variables) if variables else 0
                if kind == "RequiredCount":
                    enforce(m.Add(total == bound), rule_key)
                elif kind == "MinCoverage":
                    enforce(m.Add(total >= bound), rule_key)
                else:
                    enforce(m.Add(total <= bound), rule_key)
        return

    # ── RequiresQualification: per DATE, never once per period ────────────────
    if kind == "RequiresQualification":
        qualification_id = problem.qualification_id_of_key[str(predicate["qualification"])]
        for (mid, d, sid), var in scoped_cells():
            if problem.holds_on(mid, qualification_id, d):
                continue
            enforce(m.Add(var == 0), rule_key)
        return

    # ── RK-RULING-02 / 03: stable-id membership and admission ─────────────────
    if kind == "MemberOfStaffGroup":
        members = problem.staff_group_members[str(predicate["staffGroup"])]
        for (mid, _d, _sid), var in scoped_cells():
            if mid in members:
                continue
            enforce(m.Add(var == 0), rule_key)
        return
    if kind == "ValidGroupRestriction":
        admitted_ids = set()
        for code_or_id in problem.valid_group_shift_types[str(predicate["validGroup"])]:
            admitted_ids.add(code_or_id)
        for (_mid, _d, sid), var in scoped_cells():
            if sid in admitted_ids:
                continue
            enforce(m.Add(var == 0), rule_key)
        return

    # ── RK-RULING-04: a solver-produced assignment has NO pick position ───────
    # …so every cell this model can set satisfies the restriction vacuously, and
    # there is nothing to post. Stated rather than silently omitted: the
    # constraint is absent because the ruling makes it vacuous, not because the
    # kind was forgotten. The independent checker asserts the same on the
    # candidate, where a pinned input CAN carry a real position.
    if kind == "PickPositionRestriction":
        return

    # ── RK-RULING-05: WeekdayFteLimit (authored — see the module docs) ────────
    if kind == "WeekdayFteLimit":
        weekday = str(predicate["weekday"])
        fraction = float(predicate["fteFraction"])
        weekday_dates = [d for d in window_dates if M.weekday_of(d) == weekday]
        n = len(weekday_dates)
        import math

        for membership_id in problem.membership_ids:
            terms = [int(math.ceil(fraction * n))]
            target = _weekday_target(problem, membership_id, weekday)
            if target is not None:
                terms.append(int(math.ceil(float(target["fteFraction"]) * n)))
                if target.get("maxAssignments") is not None:
                    terms.append(int(target["maxAssignments"]))
            limit = min(terms)
            variables = []
            for date in weekday_dates:
                for shift_type_id in problem.shift_type_ids:
                    key = (membership_id, date, shift_type_id)
                    if key in built.cells and scoped(*key):
                        variables.append(built.cells[key])
            if variables:
                enforce(m.Add(sum(variables) <= limit), rule_key)
        return

    if kind == "MaxConsecutive":
        max_days = int(predicate["maxDays"])
        for membership_id in problem.membership_ids:
            day_vars = _per_day(built, problem, rule, membership_id, window_dates, scoped)
            for index in range(0, max(0, len(window_dates) - max_days)):
                run = [
                    day_vars[window_dates[index + offset]]
                    for offset in range(max_days + 1)
                    if window_dates[index + offset] in day_vars
                ]
                if len(run) == max_days + 1:
                    enforce(m.Add(sum(run) <= max_days), rule_key)
        return

    if kind == "MaxAssignmentsInWindow":
        max_count = int(predicate["max"])
        span = int(predicate["windowDays"])
        for membership_id in problem.membership_ids:
            for index in range(len(window_dates)):
                block = window_dates[index : index + span]
                if len(block) < span:
                    break
                variables = []
                for date in block:
                    for shift_type_id in problem.shift_type_ids:
                        key = (membership_id, date, shift_type_id)
                        if key in built.cells and scoped(*key):
                            variables.append(built.cells[key])
                if variables:
                    enforce(m.Add(sum(variables) <= max_count), rule_key)
        return

    if kind == "MinimumRestBetween":
        # Expressed on the DATE grid: two assignments whose shift types cannot be
        # separated by `minHours` may not both be taken. The shift times come
        # from the catalogue, so the pair test is a pure arithmetic one and the
        # constraint is a plain "not both".
        min_hours = float(predicate["minHours"])
        # How far apart two assignments can be and still breach.
        #
        # This used to be `window_dates[index : index + 2]` — this date and the
        # NEXT one — which silently dropped every pair a gap day apart. A legal
        # 48-hour rest rule was therefore never posted across a demand-free day:
        # the model answered OPTIMAL and the independent checker refused the
        # candidate, so the engine reported "worker output rejected" where the
        # honest answer was INFEASIBLE. The checker (`hard-rule-check.ts`)
        # compares chronologically ADJACENT assignments at any distance, and
        # that is the semantics this now matches.
        #
        # Posting every pair whose gap is short is equivalent to the checker's
        # adjacent-only rule, not merely stricter: if some pair (a, c) is too
        # close then a's immediate successor b has start(b) <= start(c), so the
        # ADJACENT pair (a, b) is at least as close and breaches too. The two
        # formulations accept exactly the same schedules.
        #
        # `_rest_hours` does the exact arithmetic, so the bound below only
        # decides how much work to do, never what is true — but it must be an
        # OVER-estimate. A shift ends at most 48 h after the start of its own
        # date (23:59 plus `crossesMidnight`) and the later shift can start at
        # 00:00 of its date, so a day difference of D guarantees at least
        # D * 24 - 48 hours apart; a breach needs D * 24 - 48 < min_hours, i.e.
        # D < min_hours / 24 + 2.
        max_day_span = int(min_hours // 24) + 2
        for membership_id in problem.membership_ids:
            for index, date in enumerate(window_dates):
                for later in window_dates[index:]:
                    if M.day_number(later) - M.day_number(date) > max_day_span:
                        break
                    for first_id in problem.shift_type_ids:
                        for second_id in problem.shift_type_ids:
                            if later == date and first_id >= second_id:
                                continue
                            gap = _rest_hours(problem, date, first_id, later, second_id)
                            if gap is None or gap >= min_hours:
                                continue
                            a = (membership_id, date, first_id)
                            b = (membership_id, later, second_id)
                            if a in built.cells and b in built.cells and scoped(*a) and scoped(*b):
                                enforce(
                                    m.Add(built.cells[a] + built.cells[b] <= 1), rule_key
                                )
        return

    # ── CallSpacing: consecutive ON-CALL assignments, minDaysBetweenCalls apart.
    # `is_on_call` (0005, snapshot v2 per FAD-39) is the one attribute that says a
    # shift IS a call; a non-call shift is ignored entirely, which is exactly why
    # the flag had to reach the worker before this could be modelled at all.
    if kind == "CallSpacing":
        min_days = int(predicate["minDaysBetweenCalls"])
        call_ids = [s for s in problem.shift_type_ids if problem.on_call.get(s)]
        for membership_id in problem.membership_ids:
            for index, first_date in enumerate(window_dates):
                for second_date in window_dates[index + 1 :]:
                    if M.day_number(second_date) - M.day_number(first_date) >= min_days:
                        break
                    for first_id in call_ids:
                        for second_id in call_ids:
                            a = (membership_id, first_date, first_id)
                            b = (membership_id, second_date, second_id)
                            if a in built.cells and b in built.cells and scoped(*a) and scoped(*b):
                                enforce(m.Add(built.cells[a] + built.cells[b] <= 1), rule_key)
                # Two calls on ONE date are a gap of zero and breach under any
                # reading, so the same-date pair is posted separately.
                for i, first_id in enumerate(call_ids):
                    for second_id in call_ids[i + 1 :]:
                        a = (membership_id, first_date, first_id)
                        b = (membership_id, first_date, second_id)
                        if a in built.cells and b in built.cells and scoped(*a) and scoped(*b):
                            enforce(m.Add(built.cells[a] + built.cells[b] <= 1), rule_key)
        return

    # ── RK-RULING-07: consecutive calendar dates, symmetric ───────────────────
    if kind == "NoAdjacent":
        a_code, b_code = str(predicate["shiftTypeA"]), str(predicate["shiftTypeB"])
        for membership_id in problem.membership_ids:
            for index in range(len(window_dates) - 1):
                today, tomorrow = window_dates[index], window_dates[index + 1]
                for first, second in ((a_code, b_code), (b_code, a_code)):
                    left = code_cells(membership_id, today, first)
                    right = code_cells(membership_id, tomorrow, second)
                    if left and right:
                        enforce(m.Add(left[0] + right[0] <= 1), rule_key)
        return

    # ── RK-RULING-08: the run over consecutive dates, in order ────────────────
    if kind == "ForbiddenSequence":
        sequence = [str(code) for code in predicate.get("sequence") or []]
        if not sequence:
            return
        for membership_id in problem.membership_ids:
            for index in range(len(window_dates) - len(sequence) + 1):
                run = []
                for step, code in enumerate(sequence):
                    got = code_cells(membership_id, window_dates[index + step], code)
                    if not got:
                        run = []
                        break
                    run.append(got[0])
                if run:
                    enforce(m.Add(sum(run) <= len(sequence) - 1), rule_key)
        return

    # ── RK-RULING-09: same membership, same date ──────────────────────────────
    if kind in ("LinkedShifts", "ImpliesAssignment", "MutuallyExclusive"):
        if kind == "ImpliesAssignment":
            names = [str(predicate["ifShiftType"]), str(predicate["thenShiftType"])]
        else:
            names = [str(code) for code in predicate.get("shiftTypes") or []]
        for membership_id in problem.membership_ids:
            for date in window_dates:
                got = [code_cells(membership_id, date, code) for code in names]
                variables = [pair[0] for pair in got if pair]
                if len(variables) != len(names):
                    continue
                if kind == "MutuallyExclusive":
                    enforce(m.Add(sum(variables) <= 1), rule_key)
                elif kind == "ImpliesAssignment":
                    enforce(m.Add(variables[0] <= variables[1]), rule_key)
                else:
                    for other in variables[1:]:
                        enforce(m.Add(variables[0] == other), rule_key)
        return

    # ── RK-RULING-11: AvoidDate, START-date attribution ───────────────────────
    if kind == "AvoidDate":
        date = str(predicate["date"])
        for (_mid, d, _sid), var in scoped_cells(date=date):
            enforce(m.Add(var == 0), rule_key)
        return

    # ── RK-RULING-10 / the fixed family ───────────────────────────────────────
    if kind == "FixedAssignment":
        identity = str(predicate["assignmentIdentity"])
        for fixed in problem.fixed:
            if str(fixed.get("assignmentIdentityId")) != identity:
                continue
            key = (
                str(fixed.get("membershipId")),
                str(fixed.get("date")),
                str(fixed.get("shiftTypeId")),
            )
            if key in built.cells:
                enforce(m.Add(built.cells[key] == 1), rule_key)
        return

    if kind == "ProtectedRange":
        from_date, to_date = str(predicate["from"]), str(predicate["to"])
        for fixed in problem.fixed:
            date = str(fixed.get("date"))
            if date < from_date or date > to_date:
                continue
            key = (str(fixed.get("membershipId")), date, str(fixed.get("shiftTypeId")))
            if key in built.cells:
                enforce(m.Add(built.cells[key] == 1), rule_key)
        return

    # ── the two search-shaped pattern kinds ───────────────────────────────────
    if kind == "PatternRule":
        trigger = str(predicate["trigger"])
        days = set(str(day) for day in predicate.get("daysOfWeek") or [])
        segments = predicate.get("segments") or []
        for membership_id in problem.membership_ids:
            for date in window_dates:
                if M.weekday_of(date) not in days:
                    continue
                head = code_cells(membership_id, date, trigger)
                if not head:
                    continue
                for segment in segments:
                    offset = segment.get("offsetDays")
                    code = str(segment.get("shiftType"))
                    if not isinstance(offset, int):
                        continue
                    target_date = M.date_of_day_number(M.day_number(date) + offset)
                    if target_date < problem.start_date or target_date > problem.end_date:
                        # Outside the horizon the build cannot assign it; a rule
                        # impossible to obey at the boundary is a rule somebody
                        # disables, and then it is enforced nowhere.
                        continue
                    tail = code_cells(membership_id, target_date, code)
                    if tail:
                        enforce(m.Add(head[0] <= tail[0]), rule_key)
        return

    if kind == "AlternatingWeek":
        code = str(predicate["onShiftType"])
        cycle = int(predicate["cycleWeeks"])
        if cycle < 1 or not window_dates:
            return
        origin = M.day_number(window_dates[0])
        for membership_id in problem.membership_ids:
            classes = {}  # type: Dict[int, List[Any]]
            for date in window_dates:
                got = code_cells(membership_id, date, code)
                if not got:
                    continue
                week = (M.day_number(date) - origin) // 7
                classes.setdefault(week % cycle, []).append(got[0])
            if len(classes) < 2:
                continue
            # One indicator per class; at most one class may be used.
            indicators = []
            for class_index in sorted(classes):
                indicator = m.NewBoolVar("alt_%s_%s_%d" % (rule_key, membership_id, class_index))
                for var in classes[class_index]:
                    m.Add(var <= indicator)
                indicators.append(indicator)
            enforce(m.Add(sum(indicators) <= 1), rule_key)
        return

    raise M.ModelError(
        "rule_kind_not_modelled",
        "rule %s of kind %s reached the model with no branch" % (rule_key, kind),
    )


def _weekday_target(problem, membership_id, weekday):
    participant = problem.participant_of.get(membership_id) or {}
    profile = participant.get("workProfile")
    if not isinstance(profile, dict):
        return None
    for target in profile.get("weekdayTargets") or []:
        if str(target.get("day")) == weekday:
            return target
    return None


def _per_day(built, problem, rule, membership_id, window_dates, scoped):
    """One boolean per date: does this membership work at all that day?"""
    m = built.model
    out = {}
    for date in window_dates:
        variables = []
        for shift_type_id in problem.shift_type_ids:
            key = (membership_id, date, shift_type_id)
            if key in built.cells and scoped(*key):
                variables.append(built.cells[key])
        if not variables:
            continue
        worked = m.NewBoolVar("d_%s_%s_%s" % (rule.get("ruleKey"), membership_id, date))
        m.AddMaxEquality(worked, variables)
        out[date] = worked
    return out


def _rest_hours(problem, first_date, first_id, second_date, second_id):
    """Hours between the end of one shift and the start of the next, or None.

    Times come from the catalogue's `startTime`/`endTime` plus `crossesMidnight`,
    which is the same arithmetic the platform does — but it is arithmetic over
    values the snapshot already resolved, never a re-interpretation of a zone.
    """
    types = {str(st["shiftTypeId"]): st for st in problem.snapshot["shiftTypes"]}
    first, second = types.get(first_id), types.get(second_id)
    if first is None or second is None:
        return None
    end = M.day_number(first_date) * 24.0 + _hours(first.get("endTime"))
    if first.get("crossesMidnight"):
        end += 24.0
    start = M.day_number(second_date) * 24.0 + _hours(second.get("startTime"))
    return start - end


def _hours(text):
    if not isinstance(text, str) or len(text) < 5:
        return 0.0
    return float(text[0:2]) + float(text[3:5]) / 60.0


# ---------------------------------------------------------------------------
# SOFT -> objective terms. Never the other way (SPEC-04 §3.3).
# ---------------------------------------------------------------------------


def _soft(built, problem, rule, rule_key, kind, predicate):
    tier = M.SOFT_TIERS.get(kind)
    if tier is None:
        # A SOFT rule of a kind with no objective mapping. Recorded and skipped
        # rather than refused: a SOFT rule is not a promise, so omitting it costs
        # quality rather than correctness — and the omission is REPORTED in the
        # tier list, never silent.
        _tier_for(built, 90, "unmapped-soft")["unmapped"].append(rule_key)
        return
    scale, name = tier
    m = built.model
    weight = int(float(rule.get("weight") or 1))
    entry = _tier_for(built, scale, name)
    entry["ruleKeys"].append(rule_key)

    if kind in ("ShiftPreference", "AvoidDate"):
        if kind == "AvoidDate":
            wanted, avoid = None, str(predicate["date"])
        else:
            wanted, avoid = str(predicate["shiftType"]), None
        for (mid, d, sid), var in sorted(built.cells.items()):
            if not M.scope_admits(rule, problem, mid, d, sid):
                continue
            if avoid is not None and d == avoid:
                entry["_terms"].append(scale * weight * var)
            elif wanted is not None and problem.code_of.get(sid) == wanted:
                strength = str(predicate.get("strength", "prefer"))
                sign = -1 if strength in ("prefer", "strong_prefer") else 1
                magnitude = 2 if strength.startswith("strong_") else 1
                entry["_terms"].append(sign * magnitude * scale * weight * var)
        return

    if kind == "WorkPercentageTarget":
        # RK-RULING-06, authored: |count − round(target/100 × B)| in ASSIGNMENT
        # UNITS. Proportional to |achieved − target| by a constant factor, and
        # integral — so no rounding choice becomes a silent semantic one inside
        # a CP-SAT objective.
        start, end = M.scope_window(rule, problem)
        basis = len([d for d in problem.dates if start <= d <= end])
        target_pct = float(predicate["targetPercentage"])
        for membership_id in problem.membership_ids:
            variables = [
                var
                for (mid, d, sid), var in sorted(built.cells.items())
                if mid == membership_id and M.scope_admits(rule, problem, mid, d, sid)
            ]
            if not variables:
                continue
            target = int(round(target_pct / 100.0 * basis))
            deviation = m.NewIntVar(0, basis, "wpt_%s_%s" % (rule_key, membership_id))
            m.Add(deviation >= sum(variables) - target)
            m.Add(deviation >= target - sum(variables))
            entry["_terms"].append(scale * weight * deviation)
        return

    if kind in ("FairnessBalance", "CreditDistribution"):
        # E1 carries the SPREAD (max − min assignment count), which is the
        # crudest honest fairness term there is and is labelled as such: the
        # normalisation SPEC-04 §3.1 names is M4-004's, and inventing one here
        # would put an unreviewed weighting into a shipped objective.
        counts = []
        for membership_id in problem.membership_ids:
            variables = [
                var
                for (mid, d, sid), var in sorted(built.cells.items())
                if mid == membership_id and M.scope_admits(rule, problem, mid, d, sid)
            ]
            if variables:
                counts.append(sum(variables))
        if len(counts) < 2:
            return
        upper = len(problem.dates) * max(1, len(problem.shift_type_ids))
        high = m.NewIntVar(0, upper, "fair_hi_%s" % rule_key)
        low = m.NewIntVar(0, upper, "fair_lo_%s" % rule_key)
        for total in counts:
            m.Add(high >= total)
            m.Add(low <= total)
        entry["_terms"].append(scale * weight * (high - low))
        return


def _tier_for(built, scale, name):
    for entry in built.objective_tiers:
        if entry["tier"] == scale:
            return entry
    entry = {
        "tier": scale,
        "name": name,
        "weightScale": scale,
        "ruleKeys": [],
        "unmapped": [],
        "_terms": [],
    }
    built.objective_tiers.append(entry)
    built.objective_tiers.sort(key=lambda item: item["tier"])
    return entry


# ---------------------------------------------------------------------------
# T0 — structural pre-solve checks. Milliseconds, always attempted, exact when
# they fire (SPEC-04 §5).
# ---------------------------------------------------------------------------


def structural_findings(problem: M.Problem) -> List[Dict[str, Any]]:
    findings = []
    for (date, shift_type_id), required in sorted(problem.required.items()):
        if required <= 0:
            continue
        eligible = [
            membership_id
            for membership_id in problem.membership_ids
            if (membership_id, shift_type_id) in problem.eligible
        ]
        if not eligible:
            findings.append(
                {
                    "code": "no_eligible_member",
                    "date": date,
                    "shiftTypeId": shift_type_id,
                    "detail": "demand is %d and no participant is eligible" % required,
                }
            )
        elif len(eligible) < required:
            findings.append(
                {
                    "code": "eligible_capacity_below_demand",
                    "date": date,
                    "shiftTypeId": shift_type_id,
                    "detail": "demand is %d and %d participants are eligible"
                    % (required, len(eligible)),
                }
            )
    by_day = {}  # type: Dict[str, int]
    for (date, _sid), required in problem.required.items():
        by_day[date] = by_day.get(date, 0) + max(0, required)
    for date in sorted(by_day):
        if by_day[date] > len(problem.membership_ids):
            findings.append(
                {
                    "code": "day_demand_exceeds_participants",
                    "date": date,
                    "shiftTypeId": None,
                    "detail": "demand is %d across %d participants"
                    % (by_day[date], len(problem.membership_ids)),
                }
            )
    seen = {}
    for fixed in problem.fixed:
        key = (str(fixed.get("membershipId")), str(fixed.get("date")))
        if key in seen and seen[key] != str(fixed.get("shiftTypeId")):
            findings.append(
                {
                    "code": "conflicting_fixed_assignments",
                    "date": key[1],
                    "shiftTypeId": str(fixed.get("shiftTypeId")),
                    "detail": "two fixed inputs place one membership on one date",
                }
            )
        seen[key] = str(fixed.get("shiftTypeId"))
    return findings


# ---------------------------------------------------------------------------
# The solve
# ---------------------------------------------------------------------------


def _configure(solver, parameters):
    solver.parameters.random_seed = int(parameters["randomSeed"])
    solver.parameters.num_search_workers = int(parameters["numSearchWorkers"])
    solver.parameters.max_time_in_seconds = float(parameters["maxTimeInSeconds"])
    solver.parameters.interleave_search = bool(parameters["interleaveSearch"])
    deterministic = parameters.get("maxDeterministicTime")
    if deterministic is not None:
        # SPEC-04 §4 as amended: a wall-clock deadline makes the stopping point
        # machine-dependent, so a reproducibility-claiming build pins the
        # DETERMINISTIC limit. Both are set when both are given; the
        # deterministic one is what makes the claim true.
        solver.parameters.max_deterministic_time = float(deterministic)


def solve(
    snapshot: Dict[str, Any],
    parameters: Dict[str, Any],
    control: Dict[str, Any],
    channel: CancelChannel,
) -> Dict[str, Any]:
    """One solve. Returns the worker's result dict; raises :class:`ModelError`."""
    problem = M.Problem(snapshot)
    rules = M.active_rules(snapshot)
    for rule in rules:
        M.check_modellable(rule, problem)

    built = build(problem, rules, reify=False)
    solver = cp_model.CpSolver()
    _configure(solver, parameters)

    # The watcher thread, joined to the solve. EV-M0-SPC H-4: never a signal.
    stop = threading.Event()

    def watch():
        while not stop.wait(0.005):
            if channel.is_cancelled():
                solver.StopSearch()
                return

    watcher = threading.Thread(target=watch, name="sp-solver-stop", daemon=True)
    watcher.start()
    try:
        status = solver.Solve(built.model)
    finally:
        stop.set()
        watcher.join(timeout=1.0)

    tiers = [
        {
            "tier": entry["tier"],
            "name": entry["name"],
            "weightScale": entry["weightScale"],
            "ruleKeys": sorted(entry["ruleKeys"]),
            "unmappedRuleKeys": sorted(entry["unmapped"]),
            "termCount": len(entry["_terms"]),
        }
        for entry in built.objective_tiers
    ]

    if channel.is_cancelled():
        # H-6, honoured: a cancelled solve is CANCELLED. Reporting it as a
        # timeout would send a scheduler to look at a budget that was fine.
        return _result(P.STATUS_CANCELLED, P.TERMINATION_USER_CANCELLED, None, None, tiers)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        assignments = []
        for (membership_id, date, shift_type_id), var in sorted(built.cells.items()):
            if solver.Value(var) != 1:
                continue
            assignments.append(
                {
                    "membershipId": membership_id,
                    "date": date,
                    "shiftTypeId": shift_type_id,
                    "locationId": None,
                }
            )
        assignments.sort(key=lambda a: (a["date"], a["shiftTypeId"], a["membershipId"]))
        # OPTIMAL is a PROOF and is reported only when CP-SAT proved it. SPEC-04
        # §7: no optimality claim for a feasible result.
        return _result(
            P.STATUS_OPTIMAL if status == cp_model.OPTIMAL else P.STATUS_FEASIBLE,
            P.TERMINATION_COMPLETED,
            assignments,
            0,
            tiers,
            objective=int(solver.ObjectiveValue()) if built.objective_tiers else 0,
        )

    if status == cp_model.INFEASIBLE:
        explanation = explain(problem, rules, parameters, control)
        return _result(
            P.STATUS_INFEASIBLE,
            P.TERMINATION_COMPLETED,
            None,
            None,
            tiers,
            explanation=explanation,
        )

    if status == cp_model.MODEL_INVALID:
        return _result(P.STATUS_MODEL_INVALID, P.TERMINATION_REJECTED, None, None, tiers)

    # UNKNOWN. "I stopped without deciding" — which, when the wall clock ran out,
    # is a TIMEOUT and not a completion. The two are different things a scheduler
    # responds to differently, so they are not collapsed (SPEC-04 §2).
    if solver.WallTime() >= float(parameters["maxTimeInSeconds"]):
        return _result(P.STATUS_TIMEOUT, P.TERMINATION_DEADLINE, None, None, tiers)
    return _result(P.STATUS_UNKNOWN, P.TERMINATION_COMPLETED, None, None, tiers)


def explain(problem, rules, parameters, control):
    """T0 always; T1 as a separate, budgeted, failable solve (SPEC-04 §5)."""
    t0 = structural_findings(problem)
    budget = control.get("explanationBudgetSeconds", 5.0)
    try:
        budget = float(budget)
    except (TypeError, ValueError):
        budget = 5.0

    if t0:
        # T0 fired, and it is EXACT when it does: the cause is structural and no
        # search can make it go away.
        state = "EXPLAINED_EXACT"
        subset = []
    else:
        state, subset = "EXPLANATION_UNAVAILABLE", []

    try:
        reified = build(problem, rules, reify=True)
        if reified.assumptions:
            keys = sorted(reified.assumptions)
            reified.model.AddAssumptions([reified.assumptions[k] for k in keys])
            solver = cp_model.CpSolver()
            solver.parameters.random_seed = int(parameters["randomSeed"])
            solver.parameters.num_search_workers = 1
            solver.parameters.max_time_in_seconds = budget
            status = solver.Solve(reified.model)
            if status == cp_model.INFEASIBLE:
                indices = set(solver.SufficientAssumptionsForInfeasibility())
                subset = [
                    key for key in keys if reified.assumptions[key].Index() in indices
                ]
                # NEVER `EXPLAINED_MINIMAL`: CP-SAT returns a SUFFICIENT subset,
                # not a minimal one (measured, EV-M4-002 probe 02). Minimisation
                # is T2 and is M4-004's budget work.
                #
                # T0 OUTRANKS T1. A structural finding is EXACT — no search makes
                # it go away — while a T1 subset is merely sufficient, so a T0 hit
                # keeps `EXPLAINED_EXACT` and the subset rides along as extra
                # detail. Overwriting the stronger state with the weaker one
                # would report less certainty than was actually established.
                if subset and state != "EXPLAINED_EXACT":
                    state = "EXPLAINED_SUBSET"
            elif status == cp_model.UNKNOWN and state != "EXPLAINED_EXACT":
                state = "EXPLANATION_BUDGET_EXCEEDED"
    except Exception:  # noqa: BLE001 — an explanation failure is never a schedule failure
        # SPEC-04 §5: explanation failure is reported as itself. It must never be
        # reported as scheduling infeasibility, and it must never hang.
        if state == "EXPLANATION_UNAVAILABLE":
            state = "EXPLANATION_UNAVAILABLE"

    return {"state": state, "structural": t0, "conflictingRuleKeys": sorted(subset)}


def _result(status, reason, assignments, unfilled, tiers, objective=None, explanation=None):
    return {
        "status": status,
        "terminationReason": reason,
        "assignments": assignments,
        "unfilled": unfilled,
        "objectiveTiers": tiers,
        "objectiveValue": objective,
        "explanation": explanation,
    }
