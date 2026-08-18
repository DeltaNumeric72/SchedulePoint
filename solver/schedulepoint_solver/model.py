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

# ---------------------------------------------------------------------------
# The E2 objective — OPUS-M4-004, doc 08 §3.3 and §3.4
#
# ## This is a MIRROR, and the mirror is checked
#
# The authority is `packages/domain/src/rules/objective.ts`. Python cannot import
# it, so the two are kept honest the way the status vocabulary is: the platform
# digests its profile, this file digests its own, and the worker ECHOES its
# digest on every response. A divergence is refused at the boundary rather than
# discovered in a comparison six weeks later, when two objective values that were
# never comparable have already been read side by side.
#
# ## §3.4, executed: one factor, one converter
#
# Decide the scaling factor once, globally, and document it. `scale_weight` is
# the only place a rule's authored weight becomes an integer, and it ROUNDS. The
# E1 code did `int(float(weight))`, which truncates — a SOFT rule authored at
# 0.5 contributed nothing at all, and the schedule that came back was
# indistinguishable from one where the rule had simply not bitten.
#
# Every value below is an int or an ASCII string. Deliberately: `1.0` renders as
# `1.0` here and as `1` in JavaScript, and a float in the profile would make the
# two digests disagree for a reason that has nothing to do with the objective.
# ---------------------------------------------------------------------------

OBJECTIVE_SCALE = 10000

OBJECTIVE_PROFILE_ID = "e2-default-v1"

#: `(rank, key, tierWeight, kinds)` — the mirror of `E2_OBJECTIVE_PROFILE.tiers`.
#: Rank 1 carries the largest multiplier. This is a WEIGHTED sum and the worker
#: claims nothing more: no amount of a lower tier is promised to be outranked by
#: any amount of a higher one, and no response says otherwise.
OBJECTIVE_TIERS = (
    (1, "fairness", 100, ("CreditDistribution", "FairnessBalance")),
    (2, "work-percentage", 10, ("WorkPercentageTarget",)),
    (3, "preference", 1, ("AvoidDate", "ShiftPreference")),
)

#: The tier a SOFT rule of an unmapped kind is REPORTED in. It contributes
#: nothing and exists so the omission is a line rather than an absence.
UNMAPPED_SOFT_TIER_KEY = "unmapped-soft"
UNMAPPED_SOFT_TIER_RANK = 99

#: kind -> (rank, key, tierWeight). Derived, so the table above stays the source.
SOFT_TIERS = {
    kind: (rank, key, tier_weight)
    for rank, key, tier_weight, kinds in OBJECTIVE_TIERS
    for kind in kinds
}


def scale_weight(weight):
    """A rule's authored weight, as the integer the model uses. Rounds; refuses NaN."""
    value = float(weight)
    if value != value or value in (float("inf"), float("-inf")):
        raise ModelError(
            "unmodellable_rule",
            "a SOFT rule carries a non-finite weight, which cannot become an objective term",
        )
    # `int(x + 0.5)` rather than `round`: Python 3 rounds halves to EVEN and
    # JavaScript's `Math.round` rounds halves UP, so a weight of exactly
    # 0.00005 would scale to 0 here and 1 there. Matching JavaScript is what
    # keeps the two implementations identical OVER THE DOMAIN THEY ARE GIVEN.
    #
    # REPAIR F-05 (FAD-46): "arithmetically identical" was too strong, and the
    # reviewer's probe-01 found where. On NEGATIVE half-values the two disagree —
    # `Math.round(-0.5)` is `-0` (JavaScript rounds halves toward +inf) while the
    # branch below rounds away from zero and yields -1.
    #
    # That divergence is unreachable rather than harmless, and the reason is a
    # contract, not luck: a SOFT rule must carry a weight GREATER THAN ZERO, and
    # `packages/domain/src/rules/validate.ts` refuses `weight <= 0` with "A soft
    # rule must carry a weight greater than zero." A negative weight never reaches
    # either implementation. It is recorded here rather than silently relied upon,
    # because the day that contract is relaxed this comment is the only thing that
    # says the two scalers stop agreeing.
    return int(value * OBJECTIVE_SCALE + 0.5) if value >= 0 else -int(-value * OBJECTIVE_SCALE + 0.5)


def objective_profile():
    """The profile, as a plain dict. Rendered and digested by `canonical_dumps`."""
    return {
        "profileId": OBJECTIVE_PROFILE_ID,
        "scale": OBJECTIVE_SCALE,
        "tiers": [
            {"kinds": list(kinds), "key": key, "rank": rank, "tierWeight": tier_weight}
            for rank, key, tier_weight, kinds in OBJECTIVE_TIERS
        ],
    }


def objective_profile_digest():
    """SHA-256 over the canonical rendering — the value the platform compares.

    ``canonical_dumps`` is REUSED rather than re-spelled here. It is already the
    function whose byte-for-byte agreement with ``canonicalStringify`` the RPC
    depends on, and a second local rendering would be a second thing that could
    drift — with the symptom being an honest worker refused for a forged
    objective.
    """
    import hashlib

    from .protocol import canonical_dumps

    return hashlib.sha256(canonical_dumps(objective_profile()).encode("utf-8")).hexdigest()

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


# ---------------------------------------------------------------------------
# Fairness — OPUS-M4-004, the E2 half of doc 08 §3.3 and SPEC-04 §7
#
# ## What E1 did, and why it had to change
#
# E1 minimised the SPREAD OF RAW ASSIGNMENT COUNTS and said so honestly: "the
# crudest honest fairness term there is". It ignored both parameters the AST
# node carries. A `FairnessBalance(metric='credits', normalisation='per_fte')`
# rule and a `FairnessBalance(metric='assignments', normalisation='none')` rule
# compiled to the identical objective term — two different authored intentions,
# one behaviour, and nothing anywhere saying which one had been honoured. That is
# the silent-skip shape SPEC-04 §3.3 forbids, wearing a SOFT rule's clothes.
#
# E2 honours both. `metric` decides what a unit of burden IS; `normalisation`
# decides what it is divided by. Both are recorded on the result, because a
# dispersion number whose basis is unstated is a number two people read as two
# different facts.
#
# ## The rulings this file authors (for FAD ratification)
#
# * **`weekend_load`** means an assignment whose START date is a Saturday or a
#   Sunday. Start-date attribution, the same rule RK-RULING-11 fixed for
#   `AvoidDate` — one spelling of "which day is this shift on", everywhere.
# * **`call_load`** means an assignment of a shift type whose `isOnCall` flag is
#   true; the flag is snapshot v2's (FAD-39) and a snapshot that omits it makes
#   the rule REFUSED rather than silently zero, exactly as `CallSpacing` is.
# * **`CreditDistribution` normalises `per_fte`.** The node carries no
#   normalisation field, and SPEC-04 §7 defines `fairness_dispersion` as the
#   coefficient of variation of *normalised* credits — an un-normalised credit
#   distribution would report a half-time participant carrying half the burden as
#   an unfairness.
# * **`per_eligible_day`** divides by the number of dates in the rule's
#   accounting window on which the membership is eligible for at least one
#   in-scope shift type, floored at 1. A participant eligible on no day in the
#   window contributes no term at all rather than dividing by zero.
#
# ## Integer arithmetic, and where the scale goes
#
# Coefficients are expressed in units of `FAIRNESS_UNIT` so a divisor keeps four
# decimal digits of precision. The tier's own multiplier then DIVIDES that scale
# back out (`cpsat_adapter._fairness_coefficient`), so "tier weight 100" means
# the same thing in this tier as in every other one — otherwise fairness would
# outweigh preference by the accident of a scaling constant rather than by the
# recorded decision.
# ---------------------------------------------------------------------------

FAIRNESS_UNIT = OBJECTIVE_SCALE


def fairness_parameters(kind: str, predicate: Dict[str, Any]) -> Tuple[str, str]:
    """`(metric, normalisation)` for a fairness node. Both recorded on the result."""
    metric = str(predicate.get("metric") or "assignments")
    if kind == "CreditDistribution":
        # Authored ruling: the node carries no normalisation and SPEC-04 §7's
        # metric is "normalised credits", so `per_fte` is the reading of record.
        return metric, "per_fte"
    return metric, str(predicate.get("normalisation") or "none")


def _fairness_metric_units(problem: "Problem", metric: str, date: str, shift_type_id: str) -> int:
    """How much burden one assignment of this cell carries, in FAIRNESS_UNITs."""
    if metric == "assignments":
        return FAIRNESS_UNIT
    if metric == "weekend_load":
        return FAIRNESS_UNIT if weekday_of(date) in ("sat", "sun") else 0
    if metric == "call_load":
        on_call = problem.on_call.get(shift_type_id)
        if on_call is None:
            raise ModelError(
                "rule_input_not_in_snapshot",
                "a fairness rule measures call_load and shift type %s carries no isOnCall flag; "
                "measuring it as zero would be a silent skip (SPEC-04 3.3)" % shift_type_id,
            )
        return FAIRNESS_UNIT if on_call else 0
    if metric == "credits":
        for shift_type in problem.snapshot["shiftTypes"]:
            if str(shift_type["shiftTypeId"]) != shift_type_id:
                continue
            return scale_weight(shift_type.get("creditWeight") or 0)
        return 0
    raise ModelError(
        "rule_input_not_in_snapshot",
        "a fairness rule names metric %r, which this worker has no measure for" % metric,
    )


def fairness_coefficients(
    rule: Dict[str, Any],
    problem: "Problem",
    kind: str,
    predicate: Dict[str, Any],
    admits,
) -> Tuple[Dict[Tuple[str, str, str], int], str, str]:
    """Per-cell integer burden coefficients, plus the recorded metric/normalisation.

    `admits(membership_id, date, shift_type_id)` is the rule's scope filter,
    passed in rather than re-derived so there is one spelling of scope.
    """
    metric, normalisation = fairness_parameters(kind, predicate)
    start, end = scope_window(rule, problem)
    window_dates = [d for d in problem.dates if start <= d <= end]

    divisors = {}  # type: Dict[str, float]
    for membership_id in problem.membership_ids:
        if normalisation == "none":
            divisors[membership_id] = 1.0
            continue
        if normalisation == "per_fte":
            participant = problem.participant_of.get(membership_id) or {}
            profile = participant.get("workProfile")
            percentage = None
            if isinstance(profile, dict):
                percentage = profile.get("workPercentage")
            if not isinstance(percentage, (int, float)) or percentage <= 0:
                # No in-force profile carries an FTE. The membership is left OUT
                # of the term rather than assumed full-time: assuming would state
                # a fact about a person the snapshot does not carry one for.
                continue
            divisors[membership_id] = float(percentage) / 100.0
            continue
        if normalisation == "per_eligible_day":
            days = 0
            for date in window_dates:
                for shift_type_id in problem.shift_type_ids:
                    if (membership_id, shift_type_id) not in problem.eligible:
                        continue
                    if not admits(membership_id, date, shift_type_id):
                        continue
                    days += 1
                    break
            if days == 0:
                continue
            divisors[membership_id] = float(days)
            continue
        raise ModelError(
            "rule_input_not_in_snapshot",
            "a fairness rule names normalisation %r, which this worker cannot apply"
            % normalisation,
        )

    coefficients = {}  # type: Dict[Tuple[str, str, str], int]
    for membership_id, divisor in divisors.items():
        for date in window_dates:
            for shift_type_id in problem.shift_type_ids:
                if (membership_id, shift_type_id) not in problem.eligible:
                    continue
                if not admits(membership_id, date, shift_type_id):
                    continue
                units = _fairness_metric_units(problem, metric, date, shift_type_id)
                if units == 0:
                    continue
                coefficients[(membership_id, date, shift_type_id)] = int(
                    units / divisor + 0.5
                )
    return coefficients, metric, normalisation


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
