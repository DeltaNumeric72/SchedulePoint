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
};
const RK_02: PendingRuling = {
  id: 'RK-RULING-02',
  question:
    'What identifier domain does RuleScope/MemberOfStaffGroup.staffGroup name — staff_groups.name ' +
    'or staff_groups.id?',
  rulingAlone: true,
  alsoNeeds: '',
};
const RK_03: PendingRuling = {
  id: 'RK-RULING-03',
  question: 'What identifier domain does ValidGroupRestriction.validGroup name — a name or an id?',
  rulingAlone: true,
  alsoNeeds: '',
};
const RK_04: PendingRuling = {
  id: 'RK-RULING-04',
  question:
    'Does a NULL pick_position — which every manual assignment carries — satisfy or breach a ' +
    'PickPositionRestriction?',
  rulingAlone: true,
  alsoNeeds: '',
};
const RK_05: PendingRuling = {
  id: 'RK-RULING-05',
  question: 'Over what accounting period is a WeekdayFteLimit fraction a limit — a week, the period, a rolling window?',
  rulingAlone: false,
  alsoNeeds:
    'the in-force work profile and weekday FTE for each membership at the shift date, which ' +
    'reaches the evaluator as canonical solver input in M4-001',
};
const RK_06: PendingRuling = {
  id: 'RK-RULING-06',
  question:
    'Is a WorkPercentageTarget a bound at all? A target is not a bound, so "breach" is undefined ' +
    'until the owner says whether it is a floor, a ceiling, or a tolerance band.',
  rulingAlone: false,
  alsoNeeds: 'the same in-force work-profile input as RK-RULING-05',
};
const RK_07: PendingRuling = {
  id: 'RK-RULING-07',
  question:
    'Does NoAdjacent mean consecutive calendar days, or back to back in time (an end instant ' +
    'meeting a start instant)?',
  rulingAlone: true,
  alsoNeeds: '',
};
const RK_08: PendingRuling = {
  id: 'RK-RULING-08',
  question:
    'Is a ForbiddenSequence a run of the membership’s CONSECUTIVE assignments (an intervening ' +
    'third shift type breaks it), or its assignments in order (an intervening type does not)?',
  rulingAlone: true,
  alsoNeeds: '',
};
const RK_09: PendingRuling = {
  id: 'RK-RULING-09',
  question:
    'What does linkage bind — the same membership, the same date, or both? And for ' +
    'MutuallyExclusive, exclusive over what window?',
  rulingAlone: true,
  alsoNeeds: '',
};
const RK_10: PendingRuling = {
  id: 'RK-RULING-10',
  question:
    'What is a FixedAssignment.assignmentIdentity key? The AST documents a KEY and ' +
    'assignment_identities carries only a uuid id.',
  rulingAlone: false,
  alsoNeeds: 'a stable key column on assignment_identities, which is a schema change',
};
const RK_11: PendingRuling = {
  id: 'RK-RULING-11',
  question:
    'Does AvoidDate attribute an assignment to its START date (shipped, and what the daily sheet, ' +
    'the grid and D-1a already use), or to any working minute falling on the date?',
  rulingAlone: true,
  alsoNeeds: '',
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
    semanticRuling: null,
    pendingRuling: RK_01,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  MinCoverage: {
    family: 'coverage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shifts', 'schedule_requirements'],
    semanticRuling: null,
    pendingRuling: RK_01,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  MaxCoverage: {
    family: 'coverage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shifts', 'schedule_requirements'],
    semanticRuling: null,
    pendingRuling: RK_01,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },

  /* ── eligibility ──────────────────────────────────────────────────────────── */
  RequiresQualification: {
    family: 'eligibility',
    naturalClassification: 'hard',
    requiredInput: [
      'qualification_holdings',
      'qualifications.key',
      'qualifications.status',
      'assignment_snapshots.date',
    ],
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
    requiredInput: ['staff_groups', 'staff_group_members'],
    semanticRuling: null,
    pendingRuling: RK_02,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  ValidGroupRestriction: {
    family: 'eligibility',
    naturalClassification: 'hard',
    requiredInput: ['valid_groups', 'valid_group_shift_types'],
    semanticRuling: null,
    pendingRuling: RK_03,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  PickPositionRestriction: {
    family: 'eligibility',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.pick_position'],
    semanticRuling: null,
    pendingRuling: RK_04,
    evaluationOwner: 'awaiting-ruling',
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
    semanticRuling: null,
    pendingRuling: RK_05,
    evaluationOwner: 'awaiting-input',
    milestoneOwner: 'M4-001',
    openAttributionQuestion: null,
  },
  WorkPercentageTarget: {
    family: 'capacity',
    naturalClassification: 'soft',
    requiredInput: ['membership_work_profiles.work_percentage'],
    semanticRuling: null,
    pendingRuling: RK_06,
    evaluationOwner: 'awaiting-input',
    milestoneOwner: 'M4-001',
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
    semanticRuling: null,
    pendingRuling: RK_07,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  ForbiddenSequence: {
    family: 'rest-and-spacing',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.date', 'shift_types.code'],
    semanticRuling: null,
    pendingRuling: RK_08,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },

  /* ── pattern ──────────────────────────────────────────────────────────────── */
  PatternRule: {
    family: 'pattern',
    naturalClassification: 'either',
    requiredInput: ['shifts', 'shift_types.code', 'group_holidays'],
    semanticRuling:
      'Constrains the SEARCH, not the content: a pattern prescribes what a build assigns. ' +
      'Checking it against finished content would either always pass or invent a meaning.',
    pendingRuling: null,
    evaluationOwner: 'solver-and-validator',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  AlternatingWeek: {
    family: 'pattern',
    naturalClassification: 'either',
    requiredInput: ['shifts', 'shift_types.code'],
    semanticRuling: 'Constrains the SEARCH, not the content: as PatternRule.',
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
    semanticRuling: null,
    pendingRuling: RK_09,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  ImpliesAssignment: {
    family: 'linkage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shift_types.code'],
    semanticRuling: null,
    pendingRuling: RK_09,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  MutuallyExclusive: {
    family: 'linkage',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots', 'shift_types.code'],
    semanticRuling: null,
    pendingRuling: RK_09,
    evaluationOwner: 'awaiting-ruling',
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
    semanticRuling: 'No scoped assignment STARTS on the named date.',
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
    requiredInput: ['assignment_identities (no key column)', 'assignment_snapshots.is_pinned'],
    semanticRuling: null,
    pendingRuling: RK_10,
    evaluationOwner: 'awaiting-ruling',
    milestoneOwner: 'M4-002',
    openAttributionQuestion: null,
  },
  ProtectedRange: {
    family: 'fixed',
    naturalClassification: 'hard',
    requiredInput: ['assignment_snapshots.date'],
    semanticRuling:
      'Constrains the SEARCH, not the content: a protected range bounds what a build may CHANGE, ' +
      'which finished content cannot violate.',
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
  | 'data-not-modelled-at-m3';

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
  ];

  const oneRulingAwayKinds = entries
    .filter((entry) => !entry.evaluated && (entry.pendingRuling?.rulingAlone ?? false))
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
  lines.push(`| One owner ruling away, nothing else needed | ${String(counts.oneRulingAway)} |`);
  lines.push(`| Awaiting input a named later milestone owns | ${String(counts.awaitingInput)} |`);
  lines.push(`| Distinct pending rulings cited | ${String(counts.citedPendingRulings)} |`);
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
  lines.push('## Pending rulings');
  lines.push('');
  lines.push('| Id | Ruling alone unblocks | Kinds | Question | Also needs |');
  lines.push('|---|---|---|---|---|');
  for (const cited of registry.citedRulings) {
    lines.push(
      `| \`${cited.ruling.id}\` | ${cited.ruling.rulingAlone ? 'yes' : 'no'} | ${cited.kinds
        .map((kind) => `\`${kind}\``)
        .join(', ')} | ${cell(cited.ruling.question)} | ${cell(cited.ruling.alsoNeeds) || '—'} |`,
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
