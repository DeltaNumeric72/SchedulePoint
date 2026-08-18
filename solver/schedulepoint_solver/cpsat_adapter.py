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
import time
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
        _tier_for(built, M.UNMAPPED_SOFT_TIER_RANK, M.UNMAPPED_SOFT_TIER_KEY, 0)[
            "unmapped"
        ].append(rule_key)
        return
    rank, name, tier_weight = tier
    m = built.model

    # OPUS-M4-004, doc 08 §3.4. `scale_weight` ROUNDS at the one global factor;
    # the E1 spelling `int(float(weight))` truncated, so an authored 0.5 became a
    # rule that was listed everywhere and present in the objective nowhere. An
    # absent weight means 1 — an unweighted SOFT rule still counts once.
    raw_weight = rule.get("weight")
    scaled_weight = M.scale_weight(1 if raw_weight is None else raw_weight)
    coefficient = tier_weight * scaled_weight

    entry = _tier_for(built, rank, name, tier_weight)
    entry["ruleKeys"].append(rule_key)
    entry["components"].append({"ruleKey": rule_key, "scaledWeight": scaled_weight})

    if kind in ("ShiftPreference", "AvoidDate"):
        if kind == "AvoidDate":
            wanted, avoid = None, str(predicate["date"])
        else:
            wanted, avoid = str(predicate["shiftType"]), None
        for (mid, d, sid), var in sorted(built.cells.items()):
            if not M.scope_admits(rule, problem, mid, d, sid):
                continue
            if avoid is not None and d == avoid:
                entry["_terms"].append(coefficient * var)
            elif wanted is not None and problem.code_of.get(sid) == wanted:
                strength = str(predicate.get("strength", "prefer"))
                sign = -1 if strength in ("prefer", "strong_prefer") else 1
                magnitude = 2 if strength.startswith("strong_") else 1
                entry["_terms"].append(sign * magnitude * coefficient * var)
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
            entry["_terms"].append(coefficient * deviation)
        return

    if kind in ("FairnessBalance", "CreditDistribution"):
        # OPUS-M4-004. The SPREAD of the NORMALISED BURDEN, where both halves come
        # from the node's own parameters (`metric`, `normalisation`) rather than
        # being ignored as they were in E1. `model.fairness_coefficients` owns
        # every ruling and is testable without a solver; this branch only turns
        # its integers into linear statements.
        coefficients, metric, normalisation = M.fairness_coefficients(
            rule,
            problem,
            kind,
            predicate,
            lambda mid, d, sid: M.scope_admits(rule, problem, mid, d, sid),
        )
        loads = {}  # type: Dict[str, List[Any]]
        for (mid, d, sid), burden in sorted(coefficients.items()):
            key = (mid, d, sid)
            if key not in built.cells:
                continue
            loads.setdefault(mid, []).append(burden * built.cells[key])
        if len(loads) < 2:
            # One measurable participant is not a distribution. Recorded on the
            # tier rather than dropped, so "this fairness rule produced no term"
            # is visible instead of being read as "fairness was balanced".
            entry["notes"].append(
                {"ruleKey": rule_key, "code": "fewer_than_two_measurable_participants"}
            )
            return
        upper = 0
        for burden in coefficients.values():
            upper += max(0, burden)
        high = m.NewIntVar(0, upper, "fair_hi_%s" % rule_key)
        low = m.NewIntVar(0, upper, "fair_lo_%s" % rule_key)
        for membership_id in sorted(loads):
            total = sum(loads[membership_id])
            m.Add(high >= total)
            m.Add(low <= total)
        # The coefficients are in FAIRNESS_UNITs, so the tier's multiplier divides
        # that scale back out. Without this a tier weight would mean something
        # different in this tier than in every other one, and fairness would
        # outrank preference by an accident of arithmetic rather than by the
        # recorded decision. Floored at 1: a rule weighted below the unit's
        # resolution still contributes, because a term that rounds to zero is a
        # rule that was silently dropped.
        fairness_coefficient = max(1, coefficient // M.FAIRNESS_UNIT)
        entry["_terms"].append(fairness_coefficient * (high - low))
        entry["notes"].append(
            {"ruleKey": rule_key, "metric": metric, "normalisation": normalisation}
        )
        return


def _tier_for(built, rank, name, tier_weight):
    """The recorded tier for a rank, created on first use.

    `tier` carries the RANK and `weightScale` the tier's multiplier. The two were
    one field in E1 (the multiplier doubled as the identifier), which made a
    weight change look like a new tier and a re-ranking look like a weight
    change. They are separate facts and are recorded separately.
    """
    for entry in built.objective_tiers:
        if entry["tier"] == rank:
            return entry
    entry = {
        "tier": rank,
        "name": name,
        "weightScale": tier_weight,
        "scale": M.OBJECTIVE_SCALE,
        "ruleKeys": [],
        "components": [],
        "notes": [],
        "unmapped": [],
        "_terms": [],
    }
    built.objective_tiers.append(entry)
    built.objective_tiers.sort(key=lambda item: item["tier"])
    return entry


def _recorded_tiers(built):
    """The objective, as the response records it — components, weights and all.

    doc 35 §6f required behaviour 1: "every tier/component/weight is recorded in
    the response AND persisted". A tier list that named only the rules would let
    two results with different weights sit in one comparison column looking
    comparable; the SCALED weight each rule actually carried is what the
    objective value is made of, so it is what is recorded.
    """
    return [
        {
            "tier": entry["tier"],
            "name": entry["name"],
            "weightScale": entry["weightScale"],
            "scale": entry["scale"],
            "ruleKeys": sorted(entry["ruleKeys"]),
            "components": sorted(entry["components"], key=lambda item: item["ruleKey"]),
            "notes": sorted(entry["notes"], key=lambda item: item["ruleKey"]),
            "unmappedRuleKeys": sorted(entry["unmapped"]),
            "termCount": len(entry["_terms"]),
        }
        for entry in built.objective_tiers
    ]


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


def _statistics(solver, built, explanation_solves, explanation_seconds):
    """SPEC-04 §4's reproduction record, the half only the solve can supply.

    Counts and durations. **No model dump and no payload** (SPEC-04 §1.1: "the
    model is never logged in full"), so nothing here can carry a participant, a
    date or a rule's content across the boundary — `deterministicTimeUnits` is
    the one number that says how much *search* a run did independently of the
    machine it ran on, which is exactly what a reproduction attempt needs and
    what a wall clock cannot give.
    """
    def number(call, default=None):
        try:
            return call()
        except Exception:  # noqa: BLE001 — a missing statistic is recorded absent
            return default

    return {
        "branches": number(solver.NumBranches, None),
        "conflicts": number(solver.NumConflicts, None),
        "wallTimeSeconds": number(lambda: round(solver.WallTime(), 6), None),
        "userTimeSeconds": number(lambda: round(solver.UserTime(), 6), None),
        "deterministicTimeUnits": number(
            lambda: round(solver.ResponseProto().deterministic_time, 6), None
        ),
        "bestObjectiveBound": number(
            lambda: int(solver.BestObjectiveBound()) if built.objective_tiers else None, None
        ),
        "booleanVariables": len(built.cells),
        "hardRuleCount": len(built.hard_rule_keys),
        "explanationSolves": explanation_solves,
        "explanationSeconds": round(explanation_seconds, 6),
    }


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

    tiers = _recorded_tiers(built)
    statistics = _statistics(solver, built, 0, 0.0)

    if channel.is_cancelled():
        # H-6, honoured: a cancelled solve is CANCELLED. Reporting it as a
        # timeout would send a scheduler to look at a budget that was fine.
        return _result(
            P.STATUS_CANCELLED,
            P.TERMINATION_USER_CANCELLED,
            None,
            None,
            tiers,
            statistics=statistics,
        )

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
            statistics=statistics,
        )

    if status == cp_model.INFEASIBLE:
        explanation = explain(problem, rules, parameters, control)
        # The explanation's own solve budget is folded into the record, so
        # "where did the ninety seconds go" is answerable without a second run.
        statistics = _statistics(
            solver,
            built,
            explanation.get("solveCount", 0),
            explanation.get("elapsedSeconds", 0.0),
        )
        return _result(
            P.STATUS_INFEASIBLE,
            P.TERMINATION_COMPLETED,
            None,
            None,
            tiers,
            explanation=explanation,
            statistics=statistics,
        )

    if status == cp_model.MODEL_INVALID:
        return _result(
            P.STATUS_MODEL_INVALID,
            P.TERMINATION_REJECTED,
            None,
            None,
            tiers,
            statistics=statistics,
        )

    # UNKNOWN. "I stopped without deciding" — which, when the wall clock ran out,
    # is a TIMEOUT and not a completion. The two are different things a scheduler
    # responds to differently, so they are not collapsed (SPEC-04 §2).
    if solver.WallTime() >= float(parameters["maxTimeInSeconds"]):
        return _result(
            P.STATUS_TIMEOUT, P.TERMINATION_DEADLINE, None, None, tiers, statistics=statistics
        )
    return _result(
        P.STATUS_UNKNOWN, P.TERMINATION_COMPLETED, None, None, tiers, statistics=statistics
    )


# ---------------------------------------------------------------------------
# T2 — minimisation, under HARD caps (SPEC-04 §5; OPUS-M4-004)
#
#     | **T2 · Minimisation** | Iteratively shrink the T1 subset by re-solving |
#     | **Hard iteration and wall-clock cap** | **A locally minimal subset if
#     | the budget suffices** |
#
# ## The loop, and what "locally minimal" is allowed to mean
#
# Deletion-based minimisation: for each candidate rule in the T1 subset, re-solve
# with that one rule's assumption RELEASED. If the remainder is still infeasible,
# the released rule was not needed and is dropped; if it becomes feasible or the
# answer is UNKNOWN, the rule is KEPT. A rule kept because the probe returned
# UNKNOWN is kept for the honest reason — we did not establish that it could go —
# and that is why an interrupted pass can never be reported as minimal.
#
# `EXPLAINED_MINIMAL` is claimed if and only if the loop completed a FULL PASS
# over every remaining element within both caps AND every probe returned a
# definite answer. That is exactly the statement "every rule still in this set was
# shown to be necessary", which is what local minimality is. The moment either
# cap bites, or any probe comes back UNKNOWN, the state is
# `EXPLANATION_BUDGET_EXCEEDED` and the PARTIAL subset rides along — SPEC-04 §5's
# "plus the partial subset and the T0 findings".
#
# The distinction is not decorative. A subset presented as minimal is a claim
# that removing any one of these rules resolves the conflict, and a scheduler who
# acts on a false minimality claim relaxes a rule for nothing and is left with an
# infeasible period and less protection than they started with.
# ---------------------------------------------------------------------------

#: The iteration cap. One re-solve per candidate rule per pass, and a deletion
#: pass is single-sweep, so this bounds the loop at a fixed number of solves
#: regardless of how large the T1 subset is. Chosen above any plausible
#: conflicting-rule count and far below anything that could outlive its own
#: wall-clock cap.
T2_MAX_ITERATIONS = 64

#: The share of the explanation budget T2 may spend. T1 must get its solve first —
#: a subset that is possibly-not-minimal beats no subset at all — so T2 runs on
#: what is left and stops when it is gone.
T2_BUDGET_SHARE = 0.6


def explain(problem, rules, parameters, control):
    """T0 always; T1 budgeted and failable; T2 minimisation under HARD caps."""
    started = time.monotonic()
    t0 = structural_findings(problem)
    # REPAIR F-10 (FAD-46): the PLATFORM does not currently send
    # `explanationBudgetSeconds`, so every explanation in practice runs under the
    # 5.0 s default below — a worker-side constant, not a configured allowance.
    # That is recorded rather than plumbed here because the budget is a solver
    # parameter and the configuration surface that would own it is not in this
    # packet's included paths. What the response reports is the REAL allowance
    # actually used (`budgetSeconds` below is derived from this same `budget`),
    # so no reader is told a number the run did not honour.
    budget = control.get("explanationBudgetSeconds", 5.0)
    try:
        budget = float(budget)
    except (TypeError, ValueError):
        budget = 5.0
    if not budget > 0:
        budget = 5.0

    if t0:
        # T0 fired, and it is EXACT when it does: the cause is structural and no
        # search can make it go away.
        state = "EXPLAINED_EXACT"
        subset = []
    else:
        state, subset = "EXPLANATION_UNAVAILABLE", []

    solve_count = 0
    t2 = {
        "attempted": False,
        "iterations": 0,
        "removed": 0,
        "budgetSeconds": round(budget * T2_BUDGET_SHARE, 6),
        "maxIterations": T2_MAX_ITERATIONS,
        "exhausted": False,
    }

    try:
        reified = build(problem, rules, reify=True)
        if reified.assumptions:
            keys = sorted(reified.assumptions)
            status, subset_keys, solves = _assumption_solve(
                reified, keys, parameters, budget * (1.0 - T2_BUDGET_SHARE)
            )
            solve_count += solves
            if status == cp_model.INFEASIBLE:
                subset = subset_keys
                # T0 OUTRANKS T1. A structural finding is EXACT — no search makes
                # it go away — while a T1 subset is merely sufficient, so a T0 hit
                # keeps `EXPLAINED_EXACT` and the subset rides along as extra
                # detail. Overwriting the stronger state with the weaker one
                # would report less certainty than was actually established.
                if subset and state != "EXPLAINED_EXACT":
                    state = "EXPLAINED_SUBSET"

                # ── T2 ────────────────────────────────────────────────────────
                # Attempted only where it can CHANGE the answer: with T0 already
                # exact there is a stronger explanation on the table and spending
                # a budget to relabel a rider would be spending it for nothing.
                if state == "EXPLAINED_SUBSET" and len(subset) > 1:
                    t2["attempted"] = True
                    # REPAIR F-08 (FAD-46). This passed `started` — the clock
                    # from the top of `explain()`, which includes T0 and the
                    # whole of T1. T1's elapsed time was therefore charged
                    # against T2's allowance while `budgetSeconds` below recorded
                    # the FULL share, so a T1 that ran long left T2 with a
                    # fraction of the budget the record said it had. A recorded
                    # allowance that the run did not actually grant is worse than
                    # no record: `EXPLANATION_BUDGET_EXCEEDED` then looks like a
                    # hard problem when it was really a clock already spent.
                    #
                    # T2 now times from its OWN start, which is what makes
                    # `budgetSeconds` true. The two shares still cannot exceed the
                    # total: T1 is capped at (1 - share) and T2 at share.
                    minimal, subset, iterations, removed, solves = _minimise(
                        reified,
                        subset,
                        parameters,
                        time.monotonic(),
                        budget * T2_BUDGET_SHARE,
                    )
                    solve_count += solves
                    t2["iterations"] = iterations
                    t2["removed"] = removed
                    t2["exhausted"] = not minimal
                    state = "EXPLAINED_MINIMAL" if minimal else "EXPLANATION_BUDGET_EXCEEDED"
            elif status == cp_model.UNKNOWN and state != "EXPLAINED_EXACT":
                state = "EXPLANATION_BUDGET_EXCEEDED"
    except Exception:  # noqa: BLE001 — an explanation failure is never a schedule failure
        # SPEC-04 §5: explanation failure is reported as itself. It must never be
        # reported as scheduling infeasibility, and it must never hang. The
        # caller has already decided INFEASIBLE from the ORDINARY solve; nothing
        # in this function can move that, and nothing here is allowed to try.
        if state not in ("EXPLAINED_EXACT", "EXPLAINED_SUBSET"):
            state = "EXPLANATION_UNAVAILABLE"

    return {
        "state": state,
        "structural": t0,
        "conflictingRuleKeys": sorted(subset),
        "tier2": t2,
        "solveCount": solve_count,
        "elapsedSeconds": round(time.monotonic() - started, 6),
    }


def _explanation_solver(parameters, seconds):
    """One probe solver. Single-worker and wall-clock bounded, always."""
    solver = cp_model.CpSolver()
    solver.parameters.random_seed = int(parameters["randomSeed"])
    # ONE worker for every explanation probe, whatever the build asked for. A
    # parallel portfolio makes the stopping point thread-dependent, and an
    # explanation that varies run to run is an explanation nobody can act on.
    solver.parameters.num_search_workers = 1
    solver.parameters.max_time_in_seconds = max(0.05, float(seconds))
    return solver


def _assumption_solve(reified, keys, parameters, seconds):
    """T1: solve with every HARD group behind its literal; read the subset back."""
    reified.model.ClearAssumptions()
    reified.model.AddAssumptions([reified.assumptions[key] for key in keys])
    solver = _explanation_solver(parameters, seconds)
    status = solver.Solve(reified.model)
    if status != cp_model.INFEASIBLE:
        return status, [], 1
    indices = set(solver.SufficientAssumptionsForInfeasibility())
    return (
        status,
        [key for key in keys if reified.assumptions[key].Index() in indices],
        1,
    )


def _minimise(reified, subset, parameters, started, seconds):
    """Deletion-based minimisation. Returns `(minimal, subset, iterations, removed, solves)`.

    `started` is T2's OWN start (F-08). It used to be the start of the whole
    explanation, which silently spent T1's elapsed time out of T2's budget while
    the recorded `budgetSeconds` claimed the full share.

    `minimal` is `True` only when a full pass completed inside both caps with a
    definite answer for every candidate. Anything else — a cap, an UNKNOWN, a
    solver refusal — returns `False` with whatever shrinking was achieved, which
    is a strictly better answer than the T1 subset and is labelled as exactly
    that rather than as a proof.
    """
    remaining = list(subset)
    iterations = 0
    removed = 0
    solves = 0

    for candidate in list(subset):
        if iterations >= T2_MAX_ITERATIONS:
            return False, remaining, iterations, removed, solves
        elapsed = time.monotonic() - started
        if elapsed >= seconds:
            return False, remaining, iterations, removed, solves
        if len(remaining) <= 1:
            # A single-element subset is minimal by construction: the ordinary
            # solve was infeasible, so the empty set cannot explain it.
            break

        trial = [key for key in remaining if key != candidate]
        iterations += 1
        status, _subset, count = _assumption_solve(
            reified, trial, parameters, seconds - elapsed
        )
        solves += count
        if status == cp_model.INFEASIBLE:
            # Still infeasible without it — it was not needed.
            remaining = trial
            removed += 1
        elif status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            # UNKNOWN or a refusal. We did NOT establish that this rule is
            # necessary, so the pass cannot claim minimality — the rule stays and
            # the claim does not.
            return False, remaining, iterations, removed, solves

    return True, remaining, iterations, removed, solves


def _result(
    status,
    reason,
    assignments,
    unfilled,
    tiers,
    objective=None,
    explanation=None,
    statistics=None,
):
    return {
        "status": status,
        "terminationReason": reason,
        "assignments": assignments,
        "unfilled": unfilled,
        "objectiveTiers": tiers,
        "objectiveValue": objective,
        "explanation": explanation,
        "statistics": statistics,
    }
