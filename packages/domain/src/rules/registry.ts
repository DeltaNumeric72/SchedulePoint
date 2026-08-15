/**
 * The rule-kind registry — **generated from the closed AST source**
 * (OPUS-M4-000C; doc 34 §4-D, doc 35 §5).
 *
 * ## What this is, and what it replaces
 *
 * Until now the register of "which HARD rule kinds can this system evaluate, and
 * why not the rest" was `docs/evidence/EV-M3-INTEGRATION/step-06-node-kinds.md`
 * — a prose document with the counts typed into its headings. Three of those
 * typed counts were wrong (§6 below), and one of the *reasons* had been wrong
 * before that (`CallSpacing`, corrected at M3-008). A ruling document whose
 * arithmetic is typed by hand is a document that asks the owner to rule on a
 * count nobody checked.
 *
 * So the registry is now **derived**, from four code sources and nothing else:
 *
 *  - {@link RULE_NODE_KINDS} — the closed node set (`ast.ts`);
 *  - `EVALUATED_HARD_RULE_KINDS` — what the independent checker evaluates;
 *  - `NOT_EVALUABLE_REASONS` — why each other kind is not evaluated;
 *  - {@link RULE_KIND_METADATA} — this file: family, natural classification,
 *    required input, the pinned semantic ruling or the NAMED pending one,
 *    evaluation owner, and milestone owner where the input arrives later.
 *
 * `buildRuleKindRegistry` composes them and **counts**; the committed artifact
 * `rule-kind-registry.generated.md` is emitted from that composition and a
 * build-failing gate proves the committed bytes equal the generated ones. The
 * numbers therefore come from code. A kind added to the AST without an entry
 * here fails a test, and a count edited by hand fails the gate.
 *
 * ## Nothing is dropped, deferred without an owner, or narrowed
 *
 * Non-bypass rule 11. Every one of the thirty kinds carries an owner: either the
 * component that evaluates it today, or the named milestone that will, or the
 * named pending ruling that unblocks it. There is no `unowned` value and no
 * optional owner field — the type makes an ownerless kind impossible to express.
 *
 * Pure and dependency-free, like everything in this package.
 */

import { RULE_NODE_KINDS, type RuleNodeKind } from './ast.js';
import { EVALUATED_HARD_RULE_KINDS, NOT_EVALUABLE_REASONS } from './hard-rule-check.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Vocabulary
 * ──────────────────────────────────────────────────────────────────────────── */

/** The ten families SPEC-04 §3.1 groups the closed node set into. */
export const RULE_KIND_FAMILIES = [
  'coverage',
  'eligibility',
  'capacity',
  'rest-and-spacing',
  'pattern',
  'linkage',
  'preference',
  'fairness',
  'locum',
  'fixed',
] as const;
export type RuleKindFamily = (typeof RULE_KIND_FAMILIES)[number];

/**
 * How a kind is naturally classified by an author.
 *
 * Not a constraint — the `rules_hard_soft_weight` CHECK admits either
 * classification for every kind, and it must, because a group may legitimately
 * make a preference binding. It is the disposition that explains blast radius:
 * a HARD `FairnessBalance` is pathological, so `FairnessBalance` being
 * unevaluable blocks approximately nothing in practice, while a HARD
 * `RequiredCount` is the most ordinary rule there is.
 */
export const NATURAL_CLASSIFICATIONS = ['hard', 'soft', 'either'] as const;
export type NaturalClassification = (typeof NATURAL_CLASSIFICATIONS)[number];

/**
 * Who evaluates a kind, or who will.
 *
 * `independent-checker` is `hard-rule-check.ts`, the SPEC-04 §3.3 component that
 * re-validates a version's finished content and is deliberately NOT the solver.
 * `solver-and-validator` means M4-002 compiles it as a constraint AND an
 * independent validator re-checks it — never one without the other.
 */
export const EVALUATION_OWNERS = [
  'independent-checker',
  'solver-and-validator',
  'awaiting-ruling',
  'awaiting-input',
] as const;
export type EvaluationOwner = (typeof EVALUATION_OWNERS)[number];

/**
 * The milestone or slice that owns the kind's remaining work.
 *
 * A closed set, so "later" can never be written without saying later than what.
 */
export const MILESTONE_OWNERS = [
  'M3-008',
  'M4-002',
  'M4-001',
  'M5-requests',
  'templates-slice',
  'locum-slice',
] as const;
export type MilestoneOwner = (typeof MILESTONE_OWNERS)[number];

/**
 * A pending semantic ruling, with a **stable id**.
 *
 * Stable ids are minted here and never renumbered (non-bypass rule 13). They
 * exist so that a ruling can be cited from a packet, a decision record and a
 * test by the same name, and so that "the eleven one-ruling-away kinds" is a
 * derived list rather than a remembered one.
 */
export interface PendingRuling {
  readonly id: string;
  readonly question: string;
  /**
   * `true` when the ruling ALONE makes the kind evaluable — no new column, no
   * new table, no input from a later milestone.
   *
   * This is the field that produces the "one ruling away" count, and it is the
   * one step-06 §5 got wrong: its own table summed to eleven while its prose
   * said ten. Derived here, so the two cannot disagree again.
   */
  readonly rulingAlone: boolean;
  /** What else is needed when `rulingAlone` is false. Empty otherwise. */
  readonly alsoNeeds: string;
  /**
   * How the owner ruled, or `null` while the question is open (OPUS-M4-002).
   *
   * The ids are **stable** (non-bypass rule 13): a ruling that is answered is
   * recorded as answered here, never deleted and never renumbered. Deleting
   * RK-RULING-07 the day it was decided would silently break every packet,
   * decision record and test that cites it by name — and the citation would
   * still look correct.
   *
   * `oneRulingAway` counts only the entries where this is `null`, so the
   * headline number falls as questions are answered without the register losing
   * its history.
   */
  readonly resolution: string | null;
}

export interface RuleKindMetadata {
  readonly family: RuleKindFamily;
  readonly naturalClassification: NaturalClassification;
  /**
   * The concrete inputs evaluating this kind consumes — table and column names,
   * not prose. An empty list means the kind is decidable from the version's own
   * assignment rows.
   */
  readonly requiredInput: readonly string[];
  /**
   * The semantics as evaluated, when they are pinned; `null` when they are not
   * and {@link RuleKindMetadata.pendingRuling} names the question instead.
   */
  readonly semanticRuling: string | null;
  /** The named open question. `null` when the semantics are pinned. */
  readonly pendingRuling: PendingRuling | null;
  readonly evaluationOwner: EvaluationOwner;
  readonly milestoneOwner: MilestoneOwner;
  /**
   * An open question about a kind that IS evaluated — the `AvoidDate`
   * attribution case. Shipped behaviour is pinned and tested; changing it is a
   * ruling, not a bug fix, and recording it here keeps that visible.
   */
  readonly openAttributionQuestion: PendingRuling | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The pending rulings, by stable id
 * ──────────────────────────────────────────────────────────────────────────── */

const RK_01: PendingRuling = {
  id: 'RK-RULING-01',
  question:
    'What is the grouping unit a coverage count counts over — a shifts row within the version, ' +
    'a date, a date × shift type, or a date × shift type × location?',
  rulingAlone: true,
  alsoNeeds: '',
  resolution:
    'RULED (doc 35 §6d): date × shift type within the version — the demand model\u2019s own unit (FAD-16 weekday defaults; period requirements per shift type). Location is NOT a coverage dimension in M4 (R-B6: display metadata; a shift without one is legal); a per-location dimension would be a demand-model schema change, recorded as a future owner question.',
};
const RK_02: PendingRuling = {
  id: 'RK-RULING-02',
  question:
    'What identifier domain does RuleScope/MemberOfStaffGroup.staffGroup name — staff_groups.name ' +
    'or staff_groups.id?',
  rulingAlone: true,
  alsoNeeds: '',
  resolution:
    'RULED (doc 35 §6d): `staff_groups.id`, never the name. A name is mutable display and a rename must not change a rule\u2019s historical meaning; authoring resolves name → id at save.',
};
const RK_03: PendingRuling = {
  id: 'RK-RULING-03',
  question: 'What identifier domain does ValidGroupRestriction.validGroup name — a name or an id?',
  rulingAlone: true,
  alsoNeeds: '',
  resolution:
    'RULED (doc 35 §6d): `valid_groups.id`, never the name. As RK-RULING-02.',
};
const RK_04: PendingRuling = {
  id: 'RK-RULING-04',
  question:
    'Does a NULL pick_position — which every manual assignment carries — satisfy or breach a ' +
    'PickPositionRestriction?',
  rulingAlone: true,
  alsoNeeds: '',
  resolution:
    'RULED (doc 35 §6d): out of scope of the restriction — a NULL pick position satisfies VACUOUSLY. The restriction speaks about pick positions; an assignment that has none makes no statement about one. Breaching on NULL would make every manual override a breach and would manufacture a violation from an absence (the FAD-23 class). Both arms pinned.',
};
const RK_05: PendingRuling = {
  id: 'RK-RULING-05',
  question: 'Over what accounting period is a WeekdayFteLimit fraction a limit — a week, the period, a rolling window?',
  rulingAlone: false,
  alsoNeeds:
    'the in-force work profile and weekday FTE for each membership at the shift date, which ' +
    'reaches the evaluator as canonical solver input in M4-001',
  resolution:
    'AUTHORED by OPUS-M4-002 for FAD ratification: per weekday over the ACCOUNTING WINDOW (the rule\u2019s scope.dateRange intersected with the build horizon; the period when the scope names none), a membership\u2019s scoped assignments on weekday w may not exceed min(⌈node.fteFraction × N(w)⌉, ⌈profile.fteFraction(w) × N(w)⌉, profile.maxAssignments(w)) over whichever terms are present, N(w) = the count of w-dates in the window; the profile is the one in force at the build instant (S-03). MIN rather than \u201cthe profile overrides\u201d: SPEC-04 §3.3 forbids any path that RELAXES a HARD rule, so every present term binds and the tightest wins — the one departure from the packet\u2019s proposed wording, in the only direction §3.3 permits. weekday=holiday is not-evaluable: no holiday calendar is a snapshot constituent.',
};
const RK_06: PendingRuling = {
  id: 'RK-RULING-06',
  question:
    'Is a WorkPercentageTarget a bound at all? A target is not a bound, so "breach" is undefined ' +
    'until the owner says whether it is a floor, a ceiling, or a tolerance band.',
  rulingAlone: false,
  alsoNeeds: 'the same in-force work-profile input as RK-RULING-05',
  resolution:
    'AUTHORED by OPUS-M4-002 for FAD ratification: a TARGET, never a bound. It compiles to a SOFT objective term penalising |achieved − target|, expressed in ASSIGNMENT UNITS — penalty(m) = |count(m) − round(targetPercentage/100 × B(m))| where B(m) is the number of dates in the accounting window — which is proportional to |achieved − target| by a constant factor and keeps the objective integral, so no rounding choice becomes a silent semantic one. E1 carries the basic penalty; weights are E2 (M4-004). A HARD authoring is a classification contradiction with no defined breach and blocks fail-closed.',
};
const RK_07: PendingRuling = {
  id: 'RK-RULING-07',
  question:
    'Does NoAdjacent mean consecutive calendar days, or back to back in time (an end instant ' +
    'meeting a start instant)?',
  rulingAlone: true,
  alsoNeeds: '',
  resolution:
    'RULED (doc 35 §6d): CONSECUTIVE CALENDAR DATES (start-date attribution), symmetric over the pair. Instant-gap semantics belong to MinimumRestBetween alone — one concern, one spelling.',
};
const RK_08: PendingRuling = {
  id: 'RK-RULING-08',
  question:
    'Is a ForbiddenSequence a run of the membership’s CONSECUTIVE assignments (an intervening ' +
    'third shift type breaks it), or its assignments in order (an intervening type does not)?',
  rulingAlone: true,
  alsoNeeds: '',
  resolution:
    'RULED (doc 35 §6d): the named shift-type sequence matched over consecutive calendar dates, in order; an intervening different scoped assignment on a date between them BREAKS the run. Pinned with an intervening-type arm and a gap-day arm.',
};
const RK_09: PendingRuling = {
  id: 'RK-RULING-09',
  question:
    'What does linkage bind — the same membership, the same date, or both? And for ' +
    'MutuallyExclusive, exclusive over what window?',
  rulingAlone: true,
  alsoNeeds: '',
  resolution:
    'RULED (doc 35 §6d): binds the SAME MEMBERSHIP and the SAME CALENDAR DATE for LinkedShifts / ImpliesAssignment / MutuallyExclusive; MutuallyExclusive is exclusive over a single date. Wider windows are expressed through scope.dateRange, never invented per node.',
};
const RK_10: PendingRuling = {
  id: 'RK-RULING-10',
  question:
    'What is a FixedAssignment.assignmentIdentity key? The AST documents a KEY and ' +
    'assignment_identities carries only a uuid id.',
  rulingAlone: false,
  alsoNeeds: 'a stable key column on assignment_identities, which is a schema change',
  resolution:
    'RULED (doc 35 §6d) and CONFIRMED against snapshot v2 by OPUS-M4-002: the identifier domain is `assignment_identities.id` (uuid, opaque, UI-selected). The canonical input\u2019s fixedAssignments[] already carries assignmentIdentityId, so NO schema change is needed — the `alsoNeeds` line below described the v1 world and the ruling superseded it. A human-meaningful cross-period key remains a recorded future owner question.',
};
const RK_11: PendingRuling = {
  id: 'RK-RULING-11',
  question:
    'Does AvoidDate attribute an assignment to its START date (shipped, and what the daily sheet, ' +
    'the grid and D-1a already use), or to any working minute falling on the date?',
  rulingAlone: true,
  alsoNeeds: '',
  resolution:
    'RULED (doc 35 §6d): START-date attribution STANDS — consistent with the shipped evaluator, D-1a, the daily sheet and the grid. An overnight shift STARTING on the avoided date breaches; one starting the day before and spilling into it does not. An any-working-minute variant would be a NEW node kind (a schema change), never a reinterpretation.',
};

/** Every pending ruling, by id. Exported so a packet can cite one by name. */
export const RULE_KIND_PENDING_RULINGS: readonly PendingRuling[] = [
  RK_01,
  RK_02,
  RK_03,
  RK_04,
  RK_05,
  RK_06,
  RK_07,
  RK_08,
  RK_09,
  RK_10,
  RK_11,
];

/* ────────────────────────────────────────────────────────────────────────────
 * The per-kind metadata
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every one of the thirty kinds, with its family, its inputs, its ruling and its
 * owner.
 *
 * `Record<RuleNodeKind, …>` rather than a partial map: a kind added to the AST
 * without an entry here does not compile.
 */
export const RULE_KIND_METADATA: Readonly<Record<RuleNodeKind, RuleKindMetadata>> = {
  /* ── coverage ─────────────────────────────────────────────────────────────── */
  RequiredCount: {
    family: 'coverage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shifts', 'schedule_requirements'],
    semanticRuling: 'RK-RULING-01: exactly `count` scoped assignments on EVERY (date, shift type) pair the scope admits within the accounting window — including pairs with none, which is the case a row-walking checker cannot see.',
    pendingRuling: RK_01,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  MinCoverage: {
    family: 'coverage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shifts', 'schedule_requirements'],
    semanticRuling: 'RK-RULING-01: at least `min` scoped assignments per (date, shift type). As RequiredCount.',
    pendingRuling: RK_01,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  MaxCoverage: {
    family: 'coverage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shifts', 'schedule_requirements'],
    semanticRuling: 'RK-RULING-01: at most `max` scoped assignments per (date, shift type). As RequiredCount.',
    pendingRuling: RK_01,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },

  /* ── eligibility ──────────────────────────────────────────────────────────── */
  RequiresQualification: {
    family: 'eligibility',
    naturalClassification: 'hard',
    requiredInput: ['qualification_holdings', 'qualifications.key → id (snapshot v2 vocabulary)', 'qualifications.status', 'assignment_snapshots.date'],
    semanticRuling:
      'Every scoped active assignment’s assignee held the named qualification, valid at the ' +
      'assignment’s date. validAt is a fixed literal shift_date in the AST.',
    pendingRuling: null,
    evaluationOwner: 'independent-checker',
    milestoneOwner: 'M3-008',
    openAttributionQuestion: null,
  },
  MemberOfStaffGroup: {
    family: 'eligibility',
    naturalClassification: 'hard',
    requiredInput: ['staff_groups.id', 'staff_group_members (snapshot v2)'],
    semanticRuling: 'RK-RULING-02: every scoped assignment’s assignee is a member of the named `staff_groups.id`. An unknown id is not-evaluable, never “nobody is in it” — that reading would turn a typo into a breach of every row.',
    pendingRuling: RK_02,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  ValidGroupRestriction: {
    family: 'eligibility',
    naturalClassification: 'hard',
    requiredInput: ['valid_groups.id', 'valid_group_shift_types (snapshot v2)'],
    semanticRuling: 'RK-RULING-03: no scoped assignment is on a shift type the named `valid_groups.id` does not admit (`valid_group_shift_types`).',
    pendingRuling: RK_03,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  PickPositionRestriction: {
    family: 'eligibility',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.pick_position'],
    semanticRuling: 'RK-RULING-04: a real pick position outside `allowedPickPositions` breaches; a NULL one satisfies VACUOUSLY. An ABSENT column is neither — it makes the rule not-evaluable.',
    pendingRuling: RK_04,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },

  /* ── capacity ─────────────────────────────────────────────────────────────── */
  MaxAssignmentsInWindow: {
    family: 'capacity',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.date'],
    semanticRuling:
      'Per membership, no ROLLING window of windowDays consecutive dates contains more than max ' +
      'scoped assignments. The node carries no anchor and no alignment field, so a ' +
      'calendar-aligned window would have to invent one.',
    pendingRuling: null,
    evaluationOwner: 'independent-checker',
    milestoneOwner: 'M3-008',
    openAttributionQuestion: null,
  },
  WeekdayFteLimit: {
    family: 'capacity',
    naturalClassification: 'hard',
    requiredInput: ['membership_weekday_fte.fte_fraction', 'membership_work_profiles'],
    semanticRuling: 'RK-RULING-05 (authored by M4-002): per weekday over the accounting window, count ≤ min(⌈node.fteFraction × N(w)⌉, ⌈profile.fteFraction(w) × N(w)⌉, profile.maxAssignments(w)) over the present terms. MIN, because SPEC-04 §3.3 admits no path that relaxes a HARD rule.',
    pendingRuling: RK_05,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  WorkPercentageTarget: {
    family: 'capacity',
    naturalClassification: 'soft',
    requiredInput: ['membership_work_profiles.work_percentage'],
    semanticRuling: 'RK-RULING-06 (authored by M4-002): a TARGET, never a bound. SOFT objective term penalising |achieved − target| in assignment units. A HARD authoring is a classification contradiction with no defined breach and blocks fail-closed.',
    pendingRuling: RK_06,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  MaxConsecutive: {
    family: 'capacity',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.date'],
    semanticRuling:
      'Per membership, no run of more than maxDays CONSECUTIVE CALENDAR DATES carries a scoped ' +
      'assignment. Two assignments on one date are one day.',
    pendingRuling: null,
    evaluationOwner: 'independent-checker',
    milestoneOwner: 'M3-008',
    openAttributionQuestion: null,
  },

  /* ── rest and spacing ─────────────────────────────────────────────────────── */
  MinimumRestBetween: {
    family: 'rest-and-spacing',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.starts_at', 'assignment_snapshots.ends_at'],
    semanticRuling:
      'Per membership, the gap from one assignment’s ends_at to the next’s starts_at is at ' +
      'least minHours.',
    pendingRuling: null,
    evaluationOwner: 'independent-checker',
    milestoneOwner: 'M3-008',
    openAttributionQuestion: null,
  },
  CallSpacing: {
    family: 'rest-and-spacing',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.date', 'shift_types.is_on_call'],
    semanticRuling:
      'Per membership, consecutive ON-CALL assignments are at least minDaysBetweenCalls calendar ' +
      'days apart; non-call shifts are ignored. shift_types.is_on_call (migration 0005) is the ' +
      'one attribute that says a shift is a call.',
    pendingRuling: null,
    evaluationOwner: 'independent-checker',
    milestoneOwner: 'M3-008',
    openAttributionQuestion: null,
  },
  NoAdjacent: {
    family: 'rest-and-spacing',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.date', 'shift_types.code'],
    semanticRuling: 'RK-RULING-07: the pair may not fall on consecutive calendar dates for one membership, in EITHER order. Instant-gap semantics belong to MinimumRestBetween alone.',
    pendingRuling: RK_07,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  ForbiddenSequence: {
    family: 'rest-and-spacing',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.date', 'shift_types.code'],
    semanticRuling: 'RK-RULING-08: the named sequence matched over consecutive calendar dates, in order; an intervening scoped assignment or a gap day breaks the run.',
    pendingRuling: RK_08,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },

  /* ── pattern ──────────────────────────────────────────────────────────────── */
  PatternRule: {
    family: 'pattern',
    naturalClassification: 'either',
    requiredInput: ['shifts', 'shift_types.code', 'group_holidays'],
    semanticRuling: 'Constrains the SEARCH, not the content: against a finished version a pattern prescribes what a build assigns, and that reason STANDS. Against a CANDIDATE the question is different and answerable as an implication (M4-002, FAD-38(5)): trigger on a listed weekday ⇒ every segment assigned to the same membership at its offset, where the offset falls inside the build horizon.',
    pendingRuling: null,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  AlternatingWeek: {
    family: 'pattern',
    naturalClassification: 'either',
    requiredInput: ['shifts', 'shift_types.code'],
    semanticRuling: 'Constrains the SEARCH, not the content: reason STANDS. Against a candidate (M4-002, FAD-38(5)): a membership’s `onShiftType` assignments fall in ONE week class modulo cycleWeeks, counted from the accounting window’s first date because the node carries no anchor.',
    pendingRuling: null,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  TemplateAdherence: {
    family: 'pattern',
    naturalClassification: 'either',
    requiredInput: ['assignment_templates (does not exist — doc 06 §3.2)'],
    semanticRuling: null,
    pendingRuling: null,
    evaluationOwner: 'awaiting-input',
    milestoneOwner: 'templates-slice',
    openAttributionQuestion: null,
  },

  /* ── linkage ──────────────────────────────────────────────────────────────── */
  LinkedShifts: {
    family: 'linkage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shift_types.code'],
    semanticRuling: 'RK-RULING-09: same membership, same calendar date — a membership holding ANY of the named types on a date holds ALL of them.',
    pendingRuling: RK_09,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  ImpliesAssignment: {
    family: 'linkage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shift_types.code'],
    semanticRuling: 'RK-RULING-09: same membership, same calendar date — `ifShiftType` on a date requires `thenShiftType` on that date.',
    pendingRuling: RK_09,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  MutuallyExclusive: {
    family: 'linkage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shift_types.code'],
    semanticRuling: 'RK-RULING-09: at most one of the named types per membership per calendar date. Exclusive over a single date; wider windows go through scope.dateRange.',
    pendingRuling: RK_09,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },

  /* ── preference ───────────────────────────────────────────────────────────── */
  RequestHonoured: {
    family: 'preference',
    naturalClassification: 'soft',
    requiredInput: ['the request lifecycle (SPEC-08) — M5, not modelled'],
    semanticRuling: null,
    pendingRuling: null,
    evaluationOwner: 'awaiting-input',
    milestoneOwner: 'M5-requests',
    openAttributionQuestion: null,
  },
  ShiftPreference: {
    family: 'preference',
    naturalClassification: 'soft',
    requiredInput: ['assignment_snapshots', 'shift_types.code'],
    semanticRuling:
      'Constrains the SEARCH, not the content: a preference is a ranking, not a bound. It ' +
      'compiles to an objective term in M4-002.',
    pendingRuling: null,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  AvoidDate: {
    family: 'preference',
    naturalClassification: 'either',
    requiredInput: ['assignment_snapshots.date'],
    semanticRuling: 'No scoped assignment STARTS on the named date. RK-RULING-11 ruled start-date attribution STANDS; the question is answered, not open.',
    pendingRuling: null,
    evaluationOwner: 'independent-checker',
    milestoneOwner: 'M3-008',
    openAttributionQuestion: RK_11,
  },

  /* ── fairness ─────────────────────────────────────────────────────────────── */
  FairnessBalance: {
    family: 'fairness',
    naturalClassification: 'soft',
    requiredInput: ['assignment_snapshots', 'credits', 'membership_work_profiles'],
    semanticRuling:
      'Constrains the SEARCH, not the content: a balance metric has no pinned threshold to ' +
      'breach. It becomes an objective tier in M4-004.',
    pendingRuling: null,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  CreditDistribution: {
    family: 'fairness',
    naturalClassification: 'soft',
    requiredInput: ['credits'],
    semanticRuling: 'Constrains the SEARCH, not the content: as FairnessBalance.',
    pendingRuling: null,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },

  /* ── locum ────────────────────────────────────────────────────────────────── */
  StaffOverLocumPriority: {
    family: 'locum',
    naturalClassification: 'soft',
    requiredInput: ['a membership attribute distinguishing a locum — none exists (doc 06 §3.2)'],
    semanticRuling: null,
    pendingRuling: null,
    evaluationOwner: 'awaiting-input',
    milestoneOwner: 'locum-slice',
    openAttributionQuestion: null,
  },
  LocumRestriction: {
    family: 'locum',
    naturalClassification: 'hard',
    requiredInput: ['a membership attribute distinguishing a locum — none exists (doc 06 §3.2)'],
    semanticRuling: null,
    pendingRuling: null,
    evaluationOwner: 'awaiting-input',
    milestoneOwner: 'locum-slice',
    openAttributionQuestion: null,
  },

  /* ── fixed ────────────────────────────────────────────────────────────────── */
  FixedAssignment: {
    family: 'fixed',
    naturalClassification: 'hard',
    requiredInput: ['assignment_identities.id', 'the build’s fixed inputs (snapshot fixedAssignments)'],
    semanticRuling: 'RK-RULING-10: `assignment_identities.id`. The named identity appears in the candidate with the membership, date and shift type it was fixed at. Snapshot v2 carries it — no schema change.',
    pendingRuling: RK_10,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  ProtectedRange: {
    family: 'fixed',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.date'],
    semanticRuling: 'Constrains the SEARCH, not the content: reason STANDS. Against a candidate (M4-002, FAD-38(5)): every fixed input dated inside the range appears in the candidate unchanged — the fixed inputs are what make “changed” decidable (SPEC-04 §6: recorded rather than inferred).',
    pendingRuling: null,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * The generated registry
 * ──────────────────────────────────────────────────────────────────────────── */

/** The reason class of an unevaluated kind, taken from its recorded reason. */
export type NotEvaluableClass =
  | 'grouping-unit-not-pinned'
  | 'semantics-not-pinned'
  | 'identifier-domain-not-pinned'
  | 'constrains-the-search-not-the-content'
  | 'data-not-modelled-at-m3'
  /**
   * OPUS-M4-002. The kind IS pinned — as a SOFT objective term (SPEC-04 §3.3) —
   * and a HARD authoring of it is a contradiction rather than a gap: there is no
   * content a candidate could contain that would make "the preference was not
   * honoured strongly enough" a breach. Distinct from `semantics-not-pinned`
   * because nothing is waiting on a ruling; the ruling exists and says this kind
   * is not a bound.
   */
  | 'classification-contradiction';

/**
 * The class prefix of a recorded reason.
 *
 * The reasons in `NOT_EVALUABLE_REASONS` are written `class: explanation`, and
 * the class is what the counts group by. Parsed rather than duplicated so the
 * two cannot drift — a reason whose prefix is not a known class is a hard error
 * rather than an "other" bucket, because an "other" bucket is where a
 * miscategorised kind goes to be uncounted.
 */
export function notEvaluableClassOf(reason: string): NotEvaluableClass {
  const prefix = reason.slice(0, reason.indexOf(':'));
  switch (prefix) {
    case 'grouping-unit-not-pinned':
    case 'semantics-not-pinned':
    case 'identifier-domain-not-pinned':
    case 'constrains-the-search-not-the-content':
    case 'data-not-modelled-at-m3':
    case 'classification-contradiction':
      return prefix;
    default:
      throw new Error(`Unknown not-evaluable reason class: ${JSON.stringify(prefix)}`);
  }
}

export interface RegistryEntry extends RuleKindMetadata {
  readonly kind: RuleNodeKind;
  readonly evaluated: boolean;
  /** `null` for an evaluated kind. */
  readonly notEvaluableClass: NotEvaluableClass | null;
  /** `null` for an evaluated kind. */
  readonly notEvaluableReason: string | null;
}

export interface RuleKindRegistry {
  readonly entries: readonly RegistryEntry[];
  readonly counts: {
    readonly uniqueKinds: number;
    readonly evaluated: number;
    readonly notEvaluable: number;
    /** Per not-evaluable class, in a stable order. */
    readonly byNotEvaluableClass: readonly { readonly class: NotEvaluableClass; readonly count: number }[];
    readonly byFamily: readonly { readonly family: RuleKindFamily; readonly count: number }[];
    /**
     * Kinds a single owner ruling would make evaluable, with nothing else
     * needed. The number step-06 §5 typed as ten while its own table said
     * eleven.
     */
    readonly oneRulingAway: number;
    /** Kinds blocked on input a named later milestone owns. */
    readonly awaitingInput: number;
    /** Distinct pending rulings actually cited by a kind. */
    readonly citedPendingRulings: number;
  };
  /** Every kind that a single ruling unblocks, sorted. Derived, never typed. */
  readonly oneRulingAwayKinds: readonly RuleNodeKind[];
  /** Distinct rulings cited by at least one kind, in id order. */
  readonly citedRulings: readonly { readonly ruling: PendingRuling; readonly kinds: readonly RuleNodeKind[] }[];
}

/**
 * Compose the registry from the four code sources.
 *
 * Throws rather than reports when the sources disagree — a kind that is neither
 * evaluated nor given a reason, or one that is both, is a contradiction and must
 * not be rendered into an artifact that then looks authoritative.
 */
export function buildRuleKindRegistry(): RuleKindRegistry {
  const evaluated = new Set<string>(EVALUATED_HARD_RULE_KINDS);

  const entries: RegistryEntry[] = RULE_NODE_KINDS.map((kind) => {
    const metadata = RULE_KIND_METADATA[kind];
    const isEvaluated = evaluated.has(kind);
    const reason = NOT_EVALUABLE_REASONS[kind];

    if (isEvaluated && reason !== undefined) {
      throw new Error(`${kind} is both evaluated and given a not-evaluable reason.`);
    }
    if (!isEvaluated && reason === undefined) {
      throw new Error(`${kind} is neither evaluated nor given a not-evaluable reason.`);
    }

    return {
      ...metadata,
      kind,
      evaluated: isEvaluated,
      notEvaluableClass: reason === undefined ? null : notEvaluableClassOf(reason),
      notEvaluableReason: reason ?? null,
    };
  });

  const classes: NotEvaluableClass[] = [
    'grouping-unit-not-pinned',
    'semantics-not-pinned',
    'identifier-domain-not-pinned',
    'constrains-the-search-not-the-content',
    'data-not-modelled-at-m3',
    'classification-contradiction',
  ];

  /* OPUS-M4-002: only rulings that are still OPEN count. A resolved ruling stays
   * in the register with its stable id and its answer (rule 13), so this number
   * falls as questions are decided rather than as history is deleted. */
  const oneRulingAwayKinds = entries
    .filter(
      (entry) =>
        !entry.evaluated &&
        entry.pendingRuling !== null &&
        entry.pendingRuling.rulingAlone &&
        entry.pendingRuling.resolution === null,
    )
    .map((entry) => entry.kind);

  const citedIds = new Map<string, { ruling: PendingRuling; kinds: RuleNodeKind[] }>();
  for (const entry of entries) {
    for (const ruling of [entry.pendingRuling, entry.openAttributionQuestion]) {
      if (ruling === null) continue;
      const existing = citedIds.get(ruling.id);
      if (existing === undefined) citedIds.set(ruling.id, { ruling, kinds: [entry.kind] });
      else existing.kinds.push(entry.kind);
    }
  }

  return {
    entries,
    counts: {
      uniqueKinds: new Set(entries.map((entry) => entry.kind)).size,
      evaluated: entries.filter((entry) => entry.evaluated).length,
      notEvaluable: entries.filter((entry) => !entry.evaluated).length,
      byNotEvaluableClass: classes.map((name) => ({
        class: name,
        count: entries.filter((entry) => entry.notEvaluableClass === name).length,
      })),
      byFamily: RULE_KIND_FAMILIES.map((family) => ({
        family,
        count: entries.filter((entry) => entry.family === family).length,
      })),
      oneRulingAway: oneRulingAwayKinds.length,
      awaitingInput: entries.filter((entry) => entry.evaluationOwner === 'awaiting-input').length,
      citedPendingRulings: citedIds.size,
    },
    oneRulingAwayKinds,
    citedRulings: [...citedIds.values()]
      .sort((a, b) => a.ruling.id.localeCompare(b.ruling.id))
      .map((cited) => ({ ruling: cited.ruling, kinds: [...cited.kinds].sort() })),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rendering — the committed artifact
 * ──────────────────────────────────────────────────────────────────────────── */

/** Escape a cell so a pipe inside a reason cannot forge a column boundary. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Render the registry as the committed Markdown artifact.
 *
 * The renderer lives in the domain, beside the data, so the gate script is a
 * comparison and nothing else — a generator that lived in the gate could drift
 * from the data it claims to render, and the gate would keep passing.
 */
export function renderRuleKindRegistry(registry: RuleKindRegistry): string {
  const lines: string[] = [];
  const counts = registry.counts;

  lines.push('<!-- GENERATED FILE — do not edit by hand.');
  lines.push('     Source: packages/domain/src/rules/registry.ts (+ ast.ts, hard-rule-check.ts).');
  lines.push('     Regenerate: corepack pnpm gate:rule-kind-registry --write');
  lines.push('     The `rule-kind-registry` gate fails the build if these bytes drift. -->');
  lines.push('');
  lines.push('# The rule-kind registry (generated)');
  lines.push('');
  lines.push(
    'Generated from the closed AST source — `RULE_NODE_KINDS`, `EVALUATED_HARD_RULE_KINDS`, ' +
      '`NOT_EVALUABLE_REASONS` and `RULE_KIND_METADATA`. Every count below is computed, not ' +
      'typed. OPUS-M4-000C, doc 34 §4-D.',
  );
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push('| Measure | Value |');
  lines.push('|---|---|');
  lines.push(`| Unique node kinds | ${String(counts.uniqueKinds)} |`);
  lines.push(`| EVALUATED by the independent checker | ${String(counts.evaluated)} |`);
  lines.push(`| NOT-EVALUABLE | ${String(counts.notEvaluable)} |`);
  lines.push(
    `| Evaluated + not-evaluable | ${String(counts.evaluated + counts.notEvaluable)} (must equal the unique count; the two sets are disjoint) |`,
  );
  lines.push(
    `| Still ONE OPEN owner ruling away, nothing else needed | ${String(counts.oneRulingAway)} |`,
  );
  lines.push(`| Awaiting input a named later milestone owns | ${String(counts.awaitingInput)} |`);
  lines.push(`| Distinct rulings cited (open + ruled) | ${String(counts.citedPendingRulings)} |`);
  lines.push('');
  lines.push('### By not-evaluable class');
  lines.push('');
  lines.push('| Class | Kinds |');
  lines.push('|---|---|');
  for (const row of counts.byNotEvaluableClass) {
    lines.push(`| \`${row.class}\` | ${String(row.count)} |`);
  }
  lines.push('');
  lines.push('### By family');
  lines.push('');
  lines.push('| Family | Kinds |');
  lines.push('|---|---|');
  for (const row of counts.byFamily) {
    lines.push(`| \`${row.family}\` | ${String(row.count)} |`);
  }
  lines.push('');
  lines.push('## Every kind');
  lines.push('');
  lines.push(
    '| Kind | Family | Natural | Evaluated | Class | Required input | Semantics / pending ruling | Evaluation owner | Milestone owner |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const entry of registry.entries) {
    const semantics =
      entry.semanticRuling !== null
        ? cell(entry.semanticRuling)
        : entry.pendingRuling !== null
          ? `**${entry.pendingRuling.id}** — ${cell(entry.pendingRuling.question)}`
          : cell(entry.notEvaluableReason ?? '');
    const attribution =
      entry.openAttributionQuestion === null
        ? ''
        : ` _(open: **${entry.openAttributionQuestion.id}**)_`;
    lines.push(
      `| \`${entry.kind}\` | ${entry.family} | ${entry.naturalClassification} | ${
        entry.evaluated ? 'yes' : 'no'
      } | ${entry.notEvaluableClass ?? '—'} | ${cell(entry.requiredInput.join('; '))} | ${semantics}${attribution} | ${
        entry.evaluationOwner
      } | ${entry.milestoneOwner} |`,
    );
  }
  lines.push('');
  lines.push('## The ruling register');
  lines.push('');
  lines.push(
    'Stable ids, never renumbered and never deleted (non-bypass rule 13). A ruling that has ' +
      'been answered keeps its id and carries its answer; only the ones still reading OPEN ' +
      'count towards "one ruling away".',
  );
  lines.push('');
  lines.push('| Id | State | Kinds | Question | Ruling / also needs |');
  lines.push('|---|---|---|---|---|');
  for (const cited of registry.citedRulings) {
    const state = cited.ruling.resolution === null ? '**OPEN**' : 'RULED';
    const answer =
      cited.ruling.resolution === null
        ? cell(cited.ruling.alsoNeeds) || '—'
        : cell(cited.ruling.resolution);
    lines.push(
      `| \`${cited.ruling.id}\` | ${state} | ${cited.kinds
        .map((kind) => `\`${kind}\``)
        .join(', ')} | ${cell(cited.ruling.question)} | ${answer} |`,
    );
  }
  lines.push('');
  lines.push('## The one-ruling-away population');
  lines.push('');
  lines.push(
    `${String(registry.oneRulingAwayKinds.length)} kinds: ${registry.oneRulingAwayKinds
      .map((kind) => `\`${kind}\``)
      .join(', ')}.`,
  );
  lines.push('');
  return `${lines.join('\n')}`;
}
