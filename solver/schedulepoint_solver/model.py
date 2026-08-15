"""The snapshot -> model translation, with **no solver type anywhere in it**.

OPUS-M4-002. This module answers one question — *what does this problem look
like, in variables and linear statements?* — and it answers it in plain Python
data. It does not import ``ortools`` and it must not: ADR-0006 allows the solver
library in exactly ONE adapter module (``cpsat_adapter.py``), and
``apps/api/test/solver/worker-invariants.test.ts`` scans this package and fails
the build on a second importer.

Keeping the translation here rather than inside the adapter buys two things that
are hard to get later:

* **The rulings are testable without a solver.** Every RK-RULING below is a
  function over dicts, so the semantics can be exercised, and disagreed with, at
  the speed of a unit test.
* **The engine stays replaceable.** The adapter is a thin loop that turns
  :class:`ModelSpec` into CP-SAT calls. Swapping CP-SAT for something else
  rewrites the adapter and nothing here.

## The one thing this module does NOT do

It does not decide eligibility. The single verdict lives in
``packages/domain/src/eligibility`` (FROZEN, doc 34 §4-B) and is evaluated during
assembly; the snapshot carries the answer and the worker consumes it. A second
implementation here would be the S-01 defect shape across a language boundary,
where the two copies could not even be compared by a scanner.

## Identifier domains

Every domain the rulings pin is resolved here, from the **snapshot v2**
vocabularies and nothing else (FAD-38):

* shift types by ``code`` -> ``shiftTypeId`` (the AST names codes);
* qualifications by ``key`` -> ``qualificationId`` (RequiresQualification);
* staff groups and valid groups by ``id`` (RK-RULING-02/03 — never by name).

A rule naming something the vocabulary does not contain is **refused**, never
silently skipped: SPEC-04 §3.3 is absolute that a HARD rule is never skipped by
any code path, and a typo that quietly removed a constraint would produce a
schedule that looks exactly like a correct one.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

MS_PER_DAY = 86400000

#: The kinds this worker models, mirroring `EVALUATED_HARD_RULE_KINDS` plus the
#: SOFT-natural four. A HARD rule of any other kind is REFUSED (fail closed with
#: its named owner), never modelled as nothing.
HARD_KINDS = (
    "RequiredCount",
    "MinCoverage",
    "MaxCoverage",
    "RequiresQualification",
    "MemberOfStaffGroup",
    "ValidGroupRestriction",
    "PickPositionRestriction",
    "MaxAssignmentsInWindow",
    "WeekdayFteLimit",
    "MaxConsecutive",
    "MinimumRestBetween",
    "CallSpacing",
    "NoAdjacent",
    "ForbiddenSequence",
    "LinkedShifts",
    "ImpliesAssignment",
    "MutuallyExclusive",
    "AvoidDate",
    "FixedAssignment",
    "ProtectedRange",
    "PatternRule",
    "AlternatingWeek",
)

#: SOFT-natural kinds and the E1 objective tier each belongs to. The tier list is
#: recorded in every response (doc 35 §6d required behaviour 6) so a scheduler can
#: see WHAT was optimised and in what order, even though the weights themselves
#: are M4-004's to tune.
SOFT_TIERS = {
    "ShiftPreference": (10, "preference"),
    "AvoidDate": (10, "preference"),
    "WorkPercentageTarget": (20, "work-percentage"),
    "FairnessBalance": (30, "fairness"),
    "CreditDistribution": (30, "fairness"),
}

#: Later-milestone kinds, with the owner each one waits on. A HARD rule of one of
#: these FAILS THE MODEL CLOSED and the refusal names both (FAD-27).
FAIL_CLOSED_OWNERS = {
    "TemplateAdherence": "templates-slice",
    "RequestHonoured": "M5-requests",
    "StaffOverLocumPriority": "locum-slice",
    "LocumRestriction": "locum-slice",
}

#: 1970-01-01 was a THURSDAY, so epoch day 0 is Thursday. Written as a rotated
#: table rather than as `(day + 4) % 7` because the `+ 4` is the whole content of
#: the rule, and an unexplained constant in a weekday computation is exactly
#: where an off-by-one lives. The TypeScript checker states the same table.
WEEKDAY_OF_EPOCH_DAY = ("thu", "fri", "sat", "sun", "mon", "tue", "wed")


class ModelError(Exception):
    """A problem this worker will not model. Refused, never approximated."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Calendar helpers — string arithmetic, no timezone, no `datetime` parsing
#
# The snapshot's dates are already `YYYY-MM-DD` in the group's zone (the 0014
# basis), so a `datetime` here would re-interpret a date that has already been
# interpreted once. That is the class of defect the timezone basis exists to
# prevent, and it is cheaper to avoid than to detect.
# ---------------------------------------------------------------------------


def day_number(date: str) -> int:
    """`YYYY-MM-DD` to a UTC epoch day number. Total on a validated date."""
    year, month, day = int(date[0:4]), int(date[5:7]), int(date[8:10])
    # Days from the civil calendar, without `datetime`: the standard
    # days-from-civil algorithm, which is exact for every proleptic Gregorian
    # date and has no locale, no zone and no DST in it.
    y = year - (1 if month <= 2 else 0)
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def date_of_day_number(number: int) -> str:
    """The inverse of :func:`day_number`."""
    z = number + 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return "%04d-%02d-%02d" % (y + (1 if m <= 2 else 0), m, d)


def weekday_of(date: str) -> str:
    return WEEKDAY_OF_EPOCH_DAY[day_number(date) % 7]


def dates_between(start: str, end: str) -> List[str]:
    first, last = day_number(start), day_number(end)
    return [date_of_day_number(day) for day in range(first, last + 1)]


# ---------------------------------------------------------------------------
# The resolved problem
# ---------------------------------------------------------------------------


class Problem(object):
    """The snapshot, resolved into the vocabularies the model needs.

    Everything is sorted. Determinism is not decoration here: SPEC-04 §4's
    reproducibility promise is over the model as well as over the search, and a
    model whose constraint order depended on dict iteration would make a
    re-solve measure Python's hashing rather than the problem.
    """

    def __init__(self, snapshot: Dict[str, Any]) -> None:
        self.snapshot = snapshot
        self.start_date = str(snapshot["startDate"])
        self.end_date = str(snapshot["endDate"])
        self.dates = dates_between(self.start_date, self.end_date)

        active_types = [
            st for st in snapshot["shiftTypes"] if st.get("status") == "active"
        ]
        self.shift_type_ids = sorted(str(st["shiftTypeId"]) for st in active_types)
        self.code_of = {str(st["shiftTypeId"]): str(st["code"]) for st in active_types}
        self.id_of_code = {}  # type: Dict[str, str]
        for st in active_types:
            self.id_of_code.setdefault(str(st["code"]), str(st["shiftTypeId"]))
        self.on_call = {
            str(st["shiftTypeId"]): _is_on_call(st) for st in active_types
        }
        self.required_qualifications = {
            str(st["shiftTypeId"]): sorted(
                str(q) for q in st.get("requiredQualificationIds", [])
            )
            for st in active_types
        }

        self.participants = sorted(
            (str(p["membershipId"]), p) for p in snapshot["participants"]
        )
        self.membership_ids = [m for m, _ in self.participants]
        self.participant_of = dict(self.participants)

        # The snapshot's own verdict, consumed and never re-derived.
        self.eligible = set()  # type: Set[Tuple[str, str]]
        for membership_id, participant in self.participants:
            for verdict in participant.get("eligibility", []):
                if verdict.get("eligible") is True:
                    self.eligible.add((membership_id, str(verdict["shiftTypeId"])))

        # Demand: PERIOD REQUIREMENTS only. Weekday defaults are the template a
        # period is generated FROM; solving them directly would invent
        # requirement rows the period does not have. Absence means zero — the
        # requirement rows are the complete statement of what is needed.
        self.required = {}  # type: Dict[Tuple[str, str], int]
        for cell in snapshot["demand"]:
            if cell.get("source") != "period-requirement":
                continue
            count = cell.get("requiredCount")
            if not isinstance(count, int) or isinstance(count, bool):
                continue
            self.required[(str(cell["on"]), str(cell["shiftTypeId"]))] = count

        # v2 vocabularies (FAD-38).
        self.staff_group_members = {
            str(g["staffGroupId"]): set(str(m) for m in g.get("memberMembershipIds", []))
            for g in snapshot.get("staffGroups", [])
        }
        self.valid_group_shift_types = {
            str(g["validGroupId"]): set(str(s) for s in g.get("shiftTypeIds", []))
            for g in snapshot.get("validGroups", [])
        }
        self.qualification_id_of_key = {
            str(q["key"]): str(q["qualificationId"])
            for q in snapshot.get("qualifications", [])
        }

        # Holdings, per (membership, qualification) with their validity window,
        # so `RequiresQualification` can be decided PER DATE rather than once.
        self.holdings = {}  # type: Dict[Tuple[str, str], List[Tuple[str, Optional[str], str]]]
        for membership_id, participant in self.participants:
            for holding in participant.get("holdings", []):
                key = (membership_id, str(holding["qualificationId"]))
                self.holdings.setdefault(key, []).append(
                    (
                        str(holding["validFrom"])[0:10],
                        None
                        if holding.get("validUntil") in (None, "")
                        else str(holding["validUntil"])[0:10],
                        str(holding.get("status", "")),
                    )
                )

        self.fixed = sorted(
            snapshot.get("fixedAssignments", []),
            key=lambda f: (
                str(f.get("date")),
                str(f.get("shiftTypeId")),
                str(f.get("membershipId")),
            ),
        )

    def holds_on(self, membership_id: str, qualification_id: str, date: str) -> bool:
        """Did the membership hold the qualification, live, on that date?

        `status` must be `active`: a revoked holding is not a holding. The window
        is the half-open convention the whole schema uses, spelled here on the
        DATE rather than on an instant because the snapshot already resolved the
        instants once.
        """
        for valid_from, valid_until, status in self.holdings.get(
            (membership_id, qualification_id), []
        ):
            if status != "active":
                continue
            if date < valid_from:
                continue
            if valid_until is not None and date >= valid_until:
                continue
            return True
        return False

    def cells(self) -> List[Tuple[str, str, str]]:
        """Every (membership, date, shift type) the model may decide, sorted.

        The FULL grid over eligible pairs, not only the cells demand asks for.
        A coverage RULE can require a count on a (date, shift type) the
        requirement rows say nothing about, and a model built only from the
        demand rows could not represent that at all — it would report the
        contradiction as satisfied.
        """
        out = []
        for membership_id in self.membership_ids:
            for date in self.dates:
                for shift_type_id in self.shift_type_ids:
                    if (membership_id, shift_type_id) in self.eligible:
                        out.append((membership_id, date, shift_type_id))
        return out


def _is_on_call(shift_type: Dict[str, Any]) -> Optional[bool]:
    """`shift_types.is_on_call`, carried by snapshot v2 (FAD-39).

    ``None`` when the key is ABSENT, and that distinction is the whole design:
    absent is not ``False``. Defaulting to ``False`` would make every
    `CallSpacing` rule match nothing and pass — the silent skip SPEC-04 §3.3
    forbids — so the compile step refuses on ``None`` instead. The input is
    present now, and the backstop stays for whatever the snapshot omits next.
    """
    value = shift_type.get("isOnCall")
    return None if not isinstance(value, bool) else value


# ---------------------------------------------------------------------------
# Rule resolution
# ---------------------------------------------------------------------------


def active_rules(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Active rules only, in `rule_key` order. Disabled means not consulted."""
    rules = [
        rule
        for rule in snapshot.get("ruleRevisions", [])
        if rule.get("status") == "active"
    ]
    rules.sort(key=lambda rule: str(rule.get("ruleKey")))
    return rules


def classify(rule: Dict[str, Any]) -> Tuple[str, str]:
    """`(classification, node kind)`, refusing anything malformed."""
    predicate = rule.get("predicate")
    if not isinstance(predicate, dict) or not isinstance(predicate.get("kind"), str):
        raise ModelError(
            "unmodellable_rule",
            "rule %r carries no typed predicate" % rule.get("ruleKey"),
        )
    classification = rule.get("classification")
    if classification not in ("HARD", "SOFT"):
        raise ModelError(
            "unmodellable_rule",
            "rule %r has no HARD/SOFT classification" % rule.get("ruleKey"),
        )
    return classification, str(predicate["kind"])


def check_modellable(rule: Dict[str, Any], problem: Problem) -> None:
    """Refuse, by name, every rule this worker cannot honestly model.

    Four refusal classes, and each one is a refusal rather than a skip because
    SPEC-04 §3.3 admits no path on which a HARD rule is passed over:

    * a later-milestone kind, named with its owner (FAD-27);
    * a HARD authoring of a SOFT-natural kind, which has no defined breach;
    * an identifier the snapshot vocabulary cannot resolve;
    * `CallSpacing`, whose deciding attribute the canonical input does not carry.
    """
    classification, kind = classify(rule)
    rule_key = str(rule.get("ruleKey"))

    if kind in FAIL_CLOSED_OWNERS:
        raise ModelError(
            "rule_kind_not_modelled",
            "rule %s is of kind %s, whose input is owned by %s and is not modelled at M4. "
            "A HARD rule is never skipped (SPEC-04 3.3), so this build is refused rather "
            "than solved without it" % (rule_key, kind, FAIL_CLOSED_OWNERS[kind]),
        )

    if classification == "HARD" and kind in SOFT_TIERS and kind != "AvoidDate":
        raise ModelError(
            "rule_kind_not_modelled",
            "rule %s authors %s as HARD, but that kind is a target or a ranking and has no "
            "defined breach (RK-RULING-06 and its siblings). Refused rather than modelled "
            "as an objective term, which would be the HARD-to-SOFT path SPEC-04 3.3 forbids"
            % (rule_key, kind),
        )

    if classification == "HARD" and kind not in HARD_KINDS:
        raise ModelError(
            "rule_kind_not_modelled",
            "rule %s is of HARD kind %s, which this worker has no constraint mapping for"
            % (rule_key, kind),
        )

    predicate = rule["predicate"]
    scope = rule.get("scope") or {}

    if kind == "CallSpacing":
        # FAD-39 granted `isOnCall` on the shift-type entry, so this is decidable
        # now. The refusal is RETAINED as the unknown-input backstop: a snapshot
        # that omits the flag still refuses rather than modelling a rule that
        # would match nothing and pass.
        missing = [
            sid for sid in problem.shift_type_ids if problem.on_call.get(sid) is None
        ]
        if missing:
            raise ModelError(
                "rule_input_not_in_snapshot",
                "rule %s is a CallSpacing rule and %d shift type(s) in this snapshot carry no "
                "isOnCall flag. Modelling it without that flag would make the rule match "
                "nothing, which is a silent skip (SPEC-04 3.3)" % (rule_key, len(missing)),
            )

    for staff_group_id in scope.get("staffGroups") or []:
        if str(staff_group_id) not in problem.staff_group_members:
            raise ModelError(
                "rule_identifier_unresolved",
                "rule %s is scoped to staff group %s, which is not a staff-group id in this "
                "group (RK-RULING-02)" % (rule_key, staff_group_id),
            )
    for code in scope.get("shiftTypes") or []:
        if str(code) not in problem.id_of_code:
            raise ModelError(
                "rule_identifier_unresolved",
                "rule %s is scoped to shift type %s, which this group does not define"
                % (rule_key, code),
            )

    if kind == "RequiresQualification":
        key = predicate.get("qualification")
        if str(key) not in problem.qualification_id_of_key:
            raise ModelError(
                "rule_identifier_unresolved",
                "rule %s requires qualification %r, which is not in this group's "
                "qualification vocabulary" % (rule_key, key),
            )
    if kind == "MemberOfStaffGroup":
        if str(predicate.get("staffGroup")) not in problem.staff_group_members:
            raise ModelError(
                "rule_identifier_unresolved",
                "rule %s names staff group %r, which is not a staff-group id in this group "
                "(RK-RULING-02)" % (rule_key, predicate.get("staffGroup")),
            )
    if kind == "ValidGroupRestriction":
        if str(predicate.get("validGroup")) not in problem.valid_group_shift_types:
            raise ModelError(
                "rule_identifier_unresolved",
                "rule %s names valid group %r, which is not a valid-group id in this group "
                "(RK-RULING-03)" % (rule_key, predicate.get("validGroup")),
            )
    if kind in ("WeekdayFteLimit", "PatternRule"):
        days = (
            [predicate.get("weekday")]
            if kind == "WeekdayFteLimit"
            else list(predicate.get("daysOfWeek") or [])
        )
        if "holiday" in [str(day) for day in days]:
            raise ModelError(
                "rule_input_not_in_snapshot",
                "rule %s uses the `holiday` day-arm, and no holiday calendar is a "
                "constituent of the canonical input, so which dates are holidays is not "
                "knowable here (RK-RULING-05). OWNER: the snapshot shape" % rule_key,
            )
    if kind == "FixedAssignment":
        identity = str(predicate.get("assignmentIdentity"))
        known = set(str(f.get("assignmentIdentityId")) for f in problem.fixed)
        if identity not in known:
            raise ModelError(
                "rule_identifier_unresolved",
                "rule %s pins assignment identity %s, which is not among the build's fixed "
                "inputs (RK-RULING-10)" % (rule_key, identity),
            )


def scope_window(rule: Dict[str, Any], problem: Problem) -> Tuple[str, str]:
    """The rule's accounting window: its scope range ∩ the horizon.

    The same refinement the TypeScript checker states, for the same reason: a
    rule scoped to one fortnight of a two-month period that counted the whole
    period's Mondays would permit roughly four times what it was authored to.
    """
    scope = rule.get("scope") or {}
    date_range = scope.get("dateRange")
    if not isinstance(date_range, dict):
        return problem.start_date, problem.end_date
    start = max(str(date_range.get("from")), problem.start_date)
    end = min(str(date_range.get("to")), problem.end_date)
    return start, end


def scope_admits(
    rule: Dict[str, Any],
    problem: Problem,
    membership_id: str,
    date: str,
    shift_type_id: str,
) -> bool:
    """Does the rule's scope cover this cell? The four filters, all of them."""
    scope = rule.get("scope") or {}
    start, end = scope_window(rule, problem)
    if date < start or date > end:
        return False
    codes = scope.get("shiftTypes") or []
    if codes and problem.code_of.get(shift_type_id) not in [str(c) for c in codes]:
        return False
    memberships = scope.get("memberships") or []
    if memberships and membership_id not in [str(m) for m in memberships]:
        return False
    staff_groups = scope.get("staffGroups") or []
    if staff_groups:
        # RK-RULING-02: the UNION across the named groups. Naming a second group
        # widens a scope; an intersection would make it narrower than either
        # group alone, which is the opposite of how naming one more reads.
        admitted = set()
        for staff_group_id in staff_groups:
            admitted |= problem.staff_group_members.get(str(staff_group_id), set())
        if membership_id not in admitted:
            return False
    return True
