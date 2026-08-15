import { createHash } from 'node:crypto';

import {
  COMPILER_VERSION,
  RULE_SCHEMA_VERSION,
  SOLVER_SNAPSHOT_SCHEMA_VERSION,
  type RuleNode,
  type RuleScope,
  type SnapshotDemandCell,
  type SnapshotFixedAssignment,
  type SnapshotLocation,
  type SnapshotParticipant,
  type SnapshotQualification,
  type SnapshotRuleRevision,
  type SnapshotShiftType,
  type SnapshotStaffGroup,
  type SnapshotValidGroup,
  type SnapshotWeekdayTarget,
  type SolverInputSnapshotDocument,
} from '@schedulepoint/domain';

/**
 * **The E1 benchmark corpus** — doc 35 §6d "Corpus requirements", SPEC-04 §8.
 *
 * ## What this is, and what `solver/corpus/` already was
 *
 * `solver/corpus/` (OPUS-M3-002) holds **rule-model** fixtures: hand-argued
 * feasibility certificates over an abstract problem, written before any solver
 * existed and deliberately containing no assignment generation at all. It stays
 * exactly as it is.
 *
 * This is a different artifact for a different question. These are **canonical
 * input snapshots** — the real `SolverInputSnapshotDocument` a build dispatches
 * — so each one can be posed to the actual worker and the answer compared
 * against the independent checker. The M3 corpus proves the rule model is
 * expressible; this proves the engine and the checker agree about it.
 *
 * ## Determinism, and why it is generated rather than committed as JSON
 *
 * Every identifier here is derived by SHA-256 from a fixed seed string and a
 * label. There is **no `randomUUID`, no clock, no environment, no filesystem
 * read** anywhere in this file, so a document is a pure function of its seed and
 * two runs on two machines produce the same bytes.
 *
 * The committed artifact is therefore `manifest.json`: the seed and the SHA-256
 * of the canonical rendering of each document. A test regenerates and compares.
 * Committing the documents themselves would give a second copy that could drift
 * from the generator and would still look authoritative — the failure mode the
 * `corpus-tamper` red case exists for, reproduced at ten times the size.
 *
 * ## Synthetic, and provably so
 *
 * Uuids are digests. Dates are in 2027. Every human-readable string in the
 * output is a code drawn from {@link SYNTHETIC_CODES} or a period name of the
 * form `E1 corpus <class>`. No organization, site or person name from the
 * research appears anywhere, and none can: nothing here reads any input.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Deterministic identity
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A uuid-shaped identifier, derived.
 *
 * Shaped like a version-4 uuid because that is what every consumer of the
 * document expects to see, and DERIVED because reproducibility is the whole
 * point: `randomUUID()` in a corpus generator makes the manifest a record of one
 * run rather than a property of the fixture.
 *
 * The `\x00` separator is spelled as an escape deliberately — the same lesson
 * `deriveTestPgPort` records: a raw NUL is load-bearing and invisible to both a
 * reader and to grep.
 */
export function corpusId(seed: string, label: string): string {
  const digest = createHash('sha256').update(`sp.e1.corpus.v1\x00${seed}\x00${label}`).digest(
    'hex',
  );
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

/** Every shift-type code the corpus uses. Synthetic, three letters, no meaning. */
export const SYNTHETIC_CODES = ['DAY', 'EVE', 'NGT', 'CAL', 'AUX'] as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Calendar — string arithmetic, no zone, no `Date` for the day walk
 * ──────────────────────────────────────────────────────────────────────────── */

const MS_PER_DAY = 86_400_000;

export function datesFrom(start: string, count: number): string[] {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(base + index * MS_PER_DAY).toISOString().slice(0, 10),
  );
}

/** 1970-01-01 was a Thursday. The same rotated table both evaluators state. */
const WEEKDAY_OF_EPOCH_DAY = ['thu', 'fri', 'sat', 'sun', 'mon', 'tue', 'wed'] as const;

export function weekdayOf(date: string): string {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
  return WEEKDAY_OF_EPOCH_DAY[((day % 7) + 7) % 7] ?? 'mon';
}

/* ────────────────────────────────────────────────────────────────────────────
 * The fixture record
 * ──────────────────────────────────────────────────────────────────────────── */

/** The §6d class list, verbatim, as a closed set. */
export const CORPUS_CLASSES = [
  'feasible-small',
  'feasible-medium',
  'feasible-large',
  'multisite',
  'rule-heavy',
  'progressive-pinned',
  'qualifications',
  'fte',
  'locum-shaped',
  'fairness-shaped',
  'infeasible-contradictory-rules',
  'infeasible-missing-qualification',
  'infeasible-over-demand',
  'infeasible-fixed-conflict',
  'race-retired-holding',
] as const;
export type CorpusClass = (typeof CORPUS_CLASSES)[number];

/**
 * What the fixture was BUILT to demonstrate.
 *
 * Written down as data rather than left in each test, because "the corpus
 * matched its constructed cause" is only a claim if the cause was recorded
 * before the run. An expectation edited to match an observed result is not an
 * expectation.
 */
export type CorpusExpectation =
  /** A candidate comes back, and the independent checker finds zero violations. */
  | { readonly outcome: 'solved' }
  /**
   * The solve is INFEASIBLE, and the cause is one of these.
   *
   * Both arms are optional and at least one is always present. `structural` is
   * a T0 claim (exact — no search makes it go away); `conflictingRuleKeys` is a
   * T1 claim (a SUFFICIENT assumption subset, never a minimal one). A fixture
   * may legitimately record only one.
   */
  | {
      readonly outcome: 'infeasible';
      readonly structuralCodes?: readonly string[];
      readonly conflictingRuleKeys?: readonly string[];
    }
  /**
   * The worker REFUSES to model the problem, naming the kind and its owner.
   *
   * This is not a failure and not a degraded solve: it is FAD-27's fail-closed
   * path, and a fixture that exercises it is proving that a later-milestone kind
   * cannot pass silently.
   *
   * The status is `FAILED` with termination reason `rejected` — the FAD-34
   * vocabulary for *the worker declined the request*, which is what a refusal
   * IS. It is deliberately not `MODEL_INVALID`: that word means CP-SAT found the
   * model itself ill-formed, and a refusal never built one. (This expectation
   * was recorded as `MODEL_INVALID` first and the corpus run corrected it — the
   * correction is disclosed in the evidence INDEX rather than quietly applied,
   * because a prediction that had to move is exactly the thing worth recording.)
   */
  | {
      readonly outcome: 'worker-refused';
      readonly status: 'FAILED';
      readonly terminationReason: 'rejected';
      readonly code: string;
    };

export interface CorpusFixture {
  readonly name: string;
  readonly corpusClass: CorpusClass;
  readonly seed: string;
  /** One sentence, for the per-class run summary. Never a payload. */
  readonly construction: string;
  readonly expectation: CorpusExpectation;
  readonly document: SolverInputSnapshotDocument;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The builder
 * ──────────────────────────────────────────────────────────────────────────── */

interface ShiftTypeSpec {
  readonly code: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly crossesMidnight?: boolean;
  readonly isOnCall?: boolean;
  readonly requiredQualificationKeys?: readonly string[];
}

interface ParticipantSpec {
  readonly index: number;
  readonly staffingKind?: 'staff' | 'locum';
  /** Codes this participant is eligible for. Defaults to every shift type. */
  readonly eligibleCodes?: readonly string[];
  readonly holdingKeys?: readonly string[];
  readonly holdingWindows?: ReadonlyMap<string, { from: string; until: string | null; status: string }>;
  readonly workPercentage?: number;
  readonly weekdayTargets?: readonly SnapshotWeekdayTarget[];
}

interface RuleSpec {
  readonly ruleKey: string;
  readonly classification: 'HARD' | 'SOFT';
  readonly predicate: RuleNode;
  readonly scope?: RuleScope;
  readonly weight?: string;
  readonly category?: 'general' | 'pattern' | 'staff';
}

interface FixedSpec {
  readonly label: string;
  readonly participantIndex: number;
  readonly date: string;
  readonly code: string;
  readonly isPinned?: boolean;
}

interface SnapshotSpec {
  readonly seed: string;
  readonly corpusClass: CorpusClass;
  readonly startDate?: string;
  readonly dayCount: number;
  readonly shiftTypes: readonly ShiftTypeSpec[];
  readonly participants: readonly ParticipantSpec[];
  /** `[code, requiredCount]` applied to every date, unless `demand` overrides. */
  readonly uniformDemand?: readonly (readonly [string, number])[];
  readonly demand?: readonly (readonly [string, string, number])[];
  readonly qualificationKeys?: readonly string[];
  readonly locationNames?: readonly string[];
  readonly staffGroups?: readonly (readonly [string, readonly number[]])[];
  readonly validGroups?: readonly (readonly [string, readonly number[], readonly string[]])[];
  readonly rules?: readonly RuleSpec[];
  readonly fixed?: readonly FixedSpec[];
}

const DEFAULT_START = '2027-03-01';

/**
 * Assemble one document.
 *
 * Every collection is emitted **sorted by its own key**, so the canonical
 * rendering is stable against any reordering of the spec above it. That is the
 * property the reviewer's "reordered inputs" probe attacks, and it is cheaper to
 * hold here than to assert everywhere downstream.
 */
function buildSnapshot(spec: SnapshotSpec): SolverInputSnapshotDocument {
  const { seed } = spec;
  const startDate = spec.startDate ?? DEFAULT_START;
  const dates = datesFrom(startDate, spec.dayCount);
  const endDate = dates[dates.length - 1] ?? startDate;

  const qualificationKeys = [...(spec.qualificationKeys ?? [])].sort();
  const qualifications: SnapshotQualification[] = qualificationKeys.map((key) => ({
    qualificationId: corpusId(seed, `qualification:${key}`),
    key,
    status: 'active',
  }));
  const qualificationIdOf = new Map(qualifications.map((q) => [q.key, q.qualificationId]));

  const shiftTypes: SnapshotShiftType[] = [...spec.shiftTypes]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((shiftType) => ({
      shiftTypeId: corpusId(seed, `shiftType:${shiftType.code}`),
      code: shiftType.code,
      startTime: shiftType.startTime ?? '08:00:00',
      endTime: shiftType.endTime ?? '16:00:00',
      crossesMidnight: shiftType.crossesMidnight ?? false,
      isManualOnly: false,
      isOnCall: shiftType.isOnCall ?? false,
      creditWeight: '1.00',
      status: 'active' as const,
      requiredQualificationIds: [...(shiftType.requiredQualificationKeys ?? [])]
        .sort()
        .map((key) => qualificationIdOf.get(key) ?? corpusId(seed, `qualification:${key}`)),
    }));
  const shiftTypeIdOf = new Map(shiftTypes.map((s) => [s.code, s.shiftTypeId]));
  const allCodes = shiftTypes.map((s) => s.code);

  const participants: SnapshotParticipant[] = [...spec.participants]
    .sort((a, b) => a.index - b.index)
    .map((participant) => {
      const membershipId = corpusId(seed, `membership:${String(participant.index)}`);
      const eligibleCodes = new Set(participant.eligibleCodes ?? allCodes);
      const holdings = [...(participant.holdingKeys ?? [])].sort().map((key) => {
        const window = participant.holdingWindows?.get(key);
        return {
          qualificationId: qualificationIdOf.get(key) ?? corpusId(seed, `qualification:${key}`),
          validFrom: window?.from ?? '2026-01-01T00:00:00.000Z',
          validUntil: window?.until ?? null,
          status: window?.status ?? 'active',
        };
      });
      return {
        membershipId,
        membershipKind: 'group' as const,
        staffingKind: participant.staffingKind ?? ('staff' as const),
        status: 'active' as const,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
        workProfile:
          participant.workPercentage === undefined && participant.weekdayTargets === undefined
            ? null
            : {
                workProfileId: corpusId(seed, `profile:${String(participant.index)}`),
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                workPercentage: participant.workPercentage ?? 100,
                maxAssignmentsPerWeek: null,
                maxAssignmentsPerPeriod: null,
                maxConsecutiveDays: null,
                weekdayTargets: participant.weekdayTargets ?? [],
              },
        holdings,
        eligibility: shiftTypes.map((shiftType) => ({
          shiftTypeId: shiftType.shiftTypeId,
          eligible: eligibleCodes.has(shiftType.code),
          /* The FROZEN verdict's outcome trail, as the assembly records it. It
           * is DATA here, never a re-derivation: this corpus states what the
           * verdict said, and no second eligibility spelling exists (S-01). */
          outcomes: eligibleCodes.has(shiftType.code)
            ? []
            : [`${shiftType.shiftTypeId}:not-held`],
        })),
      };
    });
  const membershipIdOf = new Map(
    [...spec.participants].map((p) => [p.index, corpusId(seed, `membership:${String(p.index)}`)]),
  );

  const demand: SnapshotDemandCell[] = [];
  for (const [code, required] of spec.uniformDemand ?? []) {
    for (const date of dates) {
      demand.push({
        source: 'period-requirement',
        shiftTypeId: shiftTypeIdOf.get(code) ?? '',
        on: date,
        requiredCount: required,
      });
    }
  }
  for (const [date, code, required] of spec.demand ?? []) {
    demand.push({
      source: 'period-requirement',
      shiftTypeId: shiftTypeIdOf.get(code) ?? '',
      on: date,
      requiredCount: required,
    });
  }
  demand.sort((a, b) => `${a.on}${a.shiftTypeId}`.localeCompare(`${b.on}${b.shiftTypeId}`));

  const locations: SnapshotLocation[] = [...(spec.locationNames ?? [])].sort().map((name) => ({
    locationId: corpusId(seed, `location:${name}`),
    name,
    status: 'active' as const,
    /* Display metadata. R-B3/FAD-31: the GROUP zone governs, and RK-RULING-01
     * keeps location out of the coverage dimension entirely. */
    timezone: null,
  }));

  const staffGroups: SnapshotStaffGroup[] = [...(spec.staffGroups ?? [])]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, indices]) => ({
      staffGroupId: corpusId(seed, `staffGroup:${label}`),
      memberMembershipIds: [...indices]
        .sort((a, b) => a - b)
        .map((index) => membershipIdOf.get(index) ?? ''),
    }));

  const validGroups: SnapshotValidGroup[] = [...(spec.validGroups ?? [])]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, positions, codes]) => ({
      validGroupId: corpusId(seed, `validGroup:${label}`),
      allowedPickPositions: [...positions].sort((a, b) => a - b),
      shiftTypeIds: [...codes].sort().map((code) => shiftTypeIdOf.get(code) ?? ''),
    }));

  const ruleRevisions: SnapshotRuleRevision[] = [...(spec.rules ?? [])]
    .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey))
    .map((rule) => ({
      ruleKey: rule.ruleKey,
      revision: '1',
      ruleSchemaVersion: RULE_SCHEMA_VERSION,
      classification: rule.classification,
      category: rule.category ?? 'general',
      weight: rule.classification === 'SOFT' ? (rule.weight ?? '1.00') : null,
      status: 'active' as const,
      scope: rule.scope ?? {},
      predicate: rule.predicate,
    }));

  const fixedAssignments: SnapshotFixedAssignment[] = [...(spec.fixed ?? [])]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((fixed) => ({
      assignmentIdentityId: corpusId(seed, `identity:${fixed.label}`),
      membershipId: membershipIdOf.get(fixed.participantIndex) ?? '',
      date: fixed.date,
      shiftTypeId: shiftTypeIdOf.get(fixed.code) ?? '',
      locationId: null,
      isPinned: fixed.isPinned ?? true,
      origin: 'manual' as const,
      creditedMembershipId: null,
      creditWeight: null,
    }));

  const constituents = [
    { kind: 'period' as const, key: corpusId(seed, 'period'), revision: '1' },
    { kind: 'version' as const, key: corpusId(seed, 'version'), revision: '1' },
    ...shiftTypes.map((s) => ({ kind: 'shiftType' as const, key: s.shiftTypeId, revision: '1' })),
    ...qualifications.map((q) => ({ kind: 'qualification' as const, key: q.key, revision: '1' })),
    ...locations.map((l) => ({ kind: 'location' as const, key: l.locationId, revision: '1' })),
    ...staffGroups.map((g) => ({
      kind: 'staffGroup' as const,
      key: g.staffGroupId,
      revision: '1',
    })),
    ...validGroups.map((g) => ({
      kind: 'validGroup' as const,
      key: g.validGroupId,
      revision: '1',
    })),
    ...ruleRevisions.map((r) => ({ kind: 'rule' as const, key: r.ruleKey, revision: r.revision })),
  ].sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`));

  return {
    snapshotSchemaVersion: SOLVER_SNAPSHOT_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    organizationId: corpusId(seed, 'organization'),
    groupId: corpusId(seed, 'group'),
    periodId: corpusId(seed, 'period'),
    versionId: corpusId(seed, 'version'),
    periodName: `E1 corpus ${spec.corpusClass}`,
    periodStatus: 'planning',
    startDate,
    endDate,
    dayCount: spec.dayCount,
    timezone: { basis: 'UTC', tzdbVersion: 'unknown', source: 'version-snapshot' },
    locations,
    shiftTypes,
    demand,
    participants,
    fixedAssignments,
    ruleRevisions,
    staffGroups,
    validGroups,
    qualifications,
    constituents,
  };
}

/** `n` participants, indices `0..n-1`, all defaults. */
function plainParticipants(count: number): ParticipantSpec[] {
  return Array.from({ length: count }, (_, index) => ({ index }));
}

/* ────────────────────────────────────────────────────────────────────────────
 * The fixtures — one per §6d class
 *
 * Each carries its CONSTRUCTED cause as data. That ordering matters: an
 * expectation recorded before the run is a prediction, and an expectation edited
 * afterwards to match what happened is a description. Only the first can fail.
 * ──────────────────────────────────────────────────────────────────────────── */

const WEEK_FULL: readonly SnapshotWeekdayTarget[] = [
  { day: 'mon', fteFraction: 1, maxAssignments: null },
  { day: 'tue', fteFraction: 1, maxAssignments: null },
  { day: 'wed', fteFraction: 1, maxAssignments: null },
  { day: 'thu', fteFraction: 1, maxAssignments: null },
  { day: 'fri', fteFraction: 1, maxAssignments: null },
  { day: 'sat', fteFraction: 0.5, maxAssignments: null },
  { day: 'sun', fteFraction: 0.5, maxAssignments: 1 },
];

/** `B-feasible-small` — the smallest problem that is still a problem. */
function feasibleSmall(): CorpusFixture {
  const seed = 'e1.feasible.small';
  return {
    name: 'B-feasible-small',
    corpusClass: 'feasible-small',
    seed,
    construction: '3 participants, 2 days, one shift type, demand 1 per day, no rules',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'feasible-small',
      dayCount: 2,
      shiftTypes: [{ code: 'DAY' }],
      participants: plainParticipants(3),
      uniformDemand: [['DAY', 1]],
    }),
  };
}

/** `B-feasible-medium` — two shift types, a fortnight, two capacity rules. */
function feasibleMedium(): CorpusFixture {
  const seed = 'e1.feasible.medium';
  return {
    name: 'B-feasible-medium',
    corpusClass: 'feasible-medium',
    seed,
    construction: '8 participants, 14 days, DAY+EVE at demand 1, MaxConsecutive and a 7-day cap',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'feasible-medium',
      dayCount: 14,
      shiftTypes: [{ code: 'DAY' }, { code: 'EVE', startTime: '16:00:00', endTime: '23:00:00' }],
      participants: plainParticipants(8),
      uniformDemand: [
        ['DAY', 1],
        ['EVE', 1],
      ],
      rules: [
        { ruleKey: 'md-consecutive', classification: 'HARD', predicate: { kind: 'MaxConsecutive', maxDays: 5 } },
        {
          ruleKey: 'md-window',
          classification: 'HARD',
          predicate: { kind: 'MaxAssignmentsInWindow', max: 5, windowDays: 7 },
        },
      ],
    }),
  };
}

/** `B-feasible-large` — 20 × 28 × 3. Big enough that a wrong model shows. */
function feasibleLarge(): CorpusFixture {
  const seed = 'e1.feasible.large';
  return {
    name: 'B-feasible-large',
    corpusClass: 'feasible-large',
    seed,
    construction: '20 participants, 28 days, DAY(2)+EVE(1)+NGT(1), MaxConsecutive 6',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'feasible-large',
      dayCount: 28,
      shiftTypes: [
        { code: 'DAY' },
        { code: 'EVE', startTime: '16:00:00', endTime: '23:00:00' },
        { code: 'NGT', startTime: '23:00:00', endTime: '07:00:00', crossesMidnight: true },
      ],
      participants: plainParticipants(20),
      uniformDemand: [
        ['DAY', 2],
        ['EVE', 1],
        ['NGT', 1],
      ],
      rules: [
        { ruleKey: 'lg-consecutive', classification: 'HARD', predicate: { kind: 'MaxConsecutive', maxDays: 6 } },
      ],
    }),
  };
}

/**
 * `B-multisite` — three locations, and **location is not a coverage dimension**.
 *
 * RK-RULING-01 is the whole subject: coverage is grouped by date × shift type
 * within the version, and a shift without a location is legal (R-B6). The
 * fixture therefore carries real locations and demand that says nothing about
 * them, and the agreement test asserts the candidate carries no location — the
 * model may not invent one, and a per-location coverage dimension would be a
 * demand-model schema change rather than a modelling choice.
 */
function multisite(): CorpusFixture {
  const seed = 'e1.multisite';
  return {
    name: 'B-multisite',
    corpusClass: 'multisite',
    seed,
    construction: '3 locations, 6 participants, 7 days, DAY+EVE demand 1 — coverage per date×type',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'multisite',
      dayCount: 7,
      shiftTypes: [{ code: 'DAY' }, { code: 'EVE', startTime: '16:00:00', endTime: '23:00:00' }],
      participants: plainParticipants(6),
      uniformDemand: [
        ['DAY', 1],
        ['EVE', 1],
      ],
      locationNames: ['site-a', 'site-b', 'site-c'],
    }),
  };
}

/**
 * `B-ruleheavy` — **every M4-evaluable HARD kind, at least once, feasible**.
 *
 * The packet's hardest corpus clause, and the one that makes the rest mean
 * something: twenty-two kinds in one problem, all satisfiable together, so the
 * solve produces a candidate the independent checker then re-derives a verdict
 * on for every one of them. A kind that appeared only in an infeasible fixture
 * would never have its SATISFIED direction exercised end to end.
 *
 * The demand shape is what makes it satisfiable: `DAY` and `CAL` every day,
 * `AUX` on Sundays only, and nothing at all for `EVE`/`NGT` — so the linkage,
 * sequence and alternating-week rules constrain cells the demand pins to zero,
 * which is a real constraint on a real variable and not a rule that was left
 * out.
 */
function ruleHeavy(): CorpusFixture {
  const seed = 'e1.ruleheavy';
  const dates = datesFrom(DEFAULT_START, 14);
  const sundays = dates.filter((date) => weekdayOf(date) === 'sun');
  const firstDate = dates[0] ?? DEFAULT_START;
  const staffGroupId = corpusId(seed, 'staffGroup:core');
  const validGroupId = corpusId(seed, 'validGroup:admitted');
  const pinnedIdentity = corpusId(seed, 'identity:opening-day');

  return {
    name: 'B-ruleheavy',
    corpusClass: 'rule-heavy',
    seed,
    construction:
      '6 participants, 14 days, 5 shift types; all 22 M4-evaluable HARD kinds present and jointly satisfiable, with a 30-hour rest rule that spans a gap day',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'rule-heavy',
      dayCount: 14,
      shiftTypes: [
        { code: 'DAY' },
        { code: 'EVE', startTime: '16:00:00', endTime: '23:00:00' },
        { code: 'NGT', startTime: '23:00:00', endTime: '07:00:00', crossesMidnight: true },
        { code: 'CAL', startTime: '18:00:00', endTime: '20:00:00', isOnCall: true },
        { code: 'AUX', startTime: '10:00:00', endTime: '12:00:00' },
      ],
      participants: Array.from({ length: 6 }, (_, index) => ({
        index,
        holdingKeys: ['q-core'],
        workPercentage: 100,
        weekdayTargets: WEEK_FULL,
      })),
      qualificationKeys: ['q-core'],
      uniformDemand: [
        ['DAY', 1],
        ['CAL', 1],
      ],
      demand: sundays.map((date) => [date, 'AUX', 1] as const),
      staffGroups: [['core', [0, 1, 2, 3, 4]]],
      validGroups: [['admitted', [1, 2], ['AUX', 'CAL', 'DAY', 'EVE']]],
      fixed: [{ label: 'opening-day', participantIndex: 0, date: firstDate, code: 'DAY' }],
      rules: [
        /* coverage — RK-RULING-01, date × shift type */
        { ruleKey: 'rh-required', classification: 'HARD', scope: { shiftTypes: ['DAY'] }, predicate: { kind: 'RequiredCount', count: 1 } },
        { ruleKey: 'rh-min', classification: 'HARD', scope: { shiftTypes: ['DAY'] }, predicate: { kind: 'MinCoverage', min: 1 } },
        { ruleKey: 'rh-max', classification: 'HARD', scope: { shiftTypes: ['DAY'] }, predicate: { kind: 'MaxCoverage', max: 2 } },
        /* eligibility — RK-RULING-02/03/04 */
        {
          ruleKey: 'rh-qualification',
          classification: 'HARD',
          scope: { shiftTypes: ['DAY'] },
          predicate: { kind: 'RequiresQualification', qualification: 'q-core', validAt: 'shift_date' },
        },
        {
          ruleKey: 'rh-staffgroup',
          classification: 'HARD',
          scope: { shiftTypes: ['DAY'] },
          predicate: { kind: 'MemberOfStaffGroup', staffGroup: staffGroupId },
        },
        {
          ruleKey: 'rh-validgroup',
          classification: 'HARD',
          scope: { shiftTypes: ['NGT'] },
          predicate: { kind: 'ValidGroupRestriction', validGroup: validGroupId },
        },
        {
          ruleKey: 'rh-pickposition',
          classification: 'HARD',
          predicate: { kind: 'PickPositionRestriction', allowedPickPositions: [1, 2] },
        },
        /* capacity — RK-RULING-05 */
        {
          ruleKey: 'rh-window',
          classification: 'HARD',
          predicate: { kind: 'MaxAssignmentsInWindow', max: 5, windowDays: 7 },
        },
        {
          ruleKey: 'rh-fte',
          classification: 'HARD',
          predicate: { kind: 'WeekdayFteLimit', weekday: 'sun', fteFraction: 1 },
        },
        { ruleKey: 'rh-consecutive', classification: 'HARD', predicate: { kind: 'MaxConsecutive', maxDays: 5 } },
        /* rest and spacing — RK-RULING-07, FAD-39 */
        /* FAD-42 R-1: this used to be `minHours: 8`, which fits inside a single
         * day — so the corpus never once asked the model for a rest pair beyond
         * the next date, and a one-day pairing window looked correct for the
         * whole milestone. At 30 the rule spans a gap day, and a participant's
         * two nearest assignments have to be two dates apart to satisfy it. */
        {
          ruleKey: 'rh-rest',
          classification: 'HARD',
          // Scoped to DAY and CAL. Two things had to hold at once.
          //
          // AUX must stay OUT of scope: unscoped at 30 hours this rule genuinely
          // contradicts `rh-pattern`, whose Saturday-DAY -> Sunday-AUX segment is
          // an 18-hour gap (DAY ends 16:00, AUX starts 10:00). The corpus run
          // says exactly that — `EXPLAINED_SUBSET T1[__demand__, rh-pattern,
          // rh-rest]` — which is the engine working correctly, just not what this
          // class is for.
          //
          // CAL must stay IN scope: `incorrect-worker-output.test.ts` case 5
          // hands the checker a DAY ending 16:00 and a CAL starting 18:00 on one
          // date and requires `rh-rest` to be the rule that names it. Scoping to
          // DAY alone silently removed that pair from the rule and took an
          // existing proof with it.
          scope: { shiftTypes: ['CAL', 'DAY'] },
          predicate: { kind: 'MinimumRestBetween', minHours: 30 },
        },
        { ruleKey: 'rh-callspacing', classification: 'HARD', predicate: { kind: 'CallSpacing', minDaysBetweenCalls: 2 } },
        {
          ruleKey: 'rh-noadjacent',
          classification: 'HARD',
          predicate: { kind: 'NoAdjacent', shiftTypeA: 'DAY', shiftTypeB: 'CAL' },
        },
        {
          ruleKey: 'rh-sequence',
          classification: 'HARD',
          predicate: { kind: 'ForbiddenSequence', sequence: ['NGT', 'NGT', 'NGT'] },
        },
        /* linkage — RK-RULING-09, same membership AND same date */
        {
          ruleKey: 'rh-linked',
          classification: 'HARD',
          predicate: { kind: 'LinkedShifts', shiftTypes: ['EVE', 'NGT'] },
        },
        {
          ruleKey: 'rh-implies',
          classification: 'HARD',
          predicate: { kind: 'ImpliesAssignment', ifShiftType: 'NGT', thenShiftType: 'EVE' },
        },
        {
          ruleKey: 'rh-mutex',
          classification: 'HARD',
          predicate: { kind: 'MutuallyExclusive', shiftTypes: ['DAY', 'NGT'] },
        },
        /* RK-RULING-11 — START-date attribution, on a date nothing needs AUX */
        {
          ruleKey: 'rh-avoiddate',
          classification: 'HARD',
          scope: { shiftTypes: ['AUX'] },
          predicate: { kind: 'AvoidDate', date: dates[2] ?? DEFAULT_START },
        },
        /* fixed — RK-RULING-10 */
        {
          ruleKey: 'rh-fixed',
          classification: 'HARD',
          predicate: { kind: 'FixedAssignment', assignmentIdentity: pinnedIdentity },
        },
        {
          ruleKey: 'rh-protected',
          classification: 'HARD',
          predicate: { kind: 'ProtectedRange', from: firstDate, to: firstDate },
        },
        /* pattern */
        {
          ruleKey: 'rh-pattern',
          classification: 'HARD',
          category: 'pattern',
          predicate: {
            kind: 'PatternRule',
            trigger: 'DAY',
            daysOfWeek: ['sat'],
            segments: [{ offsetDays: 1, shiftType: 'AUX' }],
          },
        },
        {
          ruleKey: 'rh-alternating',
          classification: 'HARD',
          category: 'pattern',
          predicate: { kind: 'AlternatingWeek', onShiftType: 'NGT', cycleWeeks: 2 },
        },
      ],
    }),
  };
}

/** `B-progressive-pinned` — a later build's fixed inputs are recorded, not inferred. */
function progressivePinned(): CorpusFixture {
  const seed = 'e1.progressive';
  const dates = datesFrom(DEFAULT_START, 7);
  return {
    name: 'B-progressive-pinned',
    corpusClass: 'progressive-pinned',
    seed,
    construction: '5 participants, 7 days; 3 pinned inputs plus FixedAssignment and ProtectedRange',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'progressive-pinned',
      dayCount: 7,
      shiftTypes: [{ code: 'DAY' }],
      participants: plainParticipants(5),
      uniformDemand: [['DAY', 1]],
      fixed: [
        { label: 'pin-0', participantIndex: 0, date: dates[0] ?? DEFAULT_START, code: 'DAY' },
        { label: 'pin-1', participantIndex: 1, date: dates[1] ?? DEFAULT_START, code: 'DAY' },
        { label: 'pin-2', participantIndex: 2, date: dates[2] ?? DEFAULT_START, code: 'DAY' },
      ],
      rules: [
        {
          ruleKey: 'pp-fixed',
          classification: 'HARD',
          predicate: { kind: 'FixedAssignment', assignmentIdentity: corpusId(seed, 'identity:pin-1') },
        },
        {
          ruleKey: 'pp-protected',
          classification: 'HARD',
          predicate: {
            kind: 'ProtectedRange',
            from: dates[0] ?? DEFAULT_START,
            to: dates[2] ?? DEFAULT_START,
          },
        },
      ],
    }),
  };
}

/** `B-qualifications` — held on the SHIFT DATE, never on the build date. */
function qualifications(): CorpusFixture {
  const seed = 'e1.qualifications';
  return {
    name: 'B-qualifications',
    corpusClass: 'qualifications',
    seed,
    construction: '4 participants, 5 days; DAY needs q-adv, two hold it, HARD RequiresQualification',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'qualifications',
      dayCount: 5,
      shiftTypes: [{ code: 'DAY', requiredQualificationKeys: ['q-adv'] }],
      qualificationKeys: ['q-adv'],
      participants: [
        { index: 0, holdingKeys: ['q-adv'] },
        { index: 1, holdingKeys: ['q-adv'] },
        /* The FROZEN verdict said no. Recorded here, never recomputed (S-01). */
        { index: 2, eligibleCodes: [] },
        { index: 3, eligibleCodes: [] },
      ],
      uniformDemand: [['DAY', 1]],
      rules: [
        {
          ruleKey: 'qu-requires',
          classification: 'HARD',
          predicate: { kind: 'RequiresQualification', qualification: 'q-adv', validAt: 'shift_date' },
        },
      ],
    }),
  };
}

/** `B-fte` — RK-RULING-05, per weekday over the period, profile override included. */
function fte(): CorpusFixture {
  const seed = 'e1.fte';
  return {
    name: 'B-fte',
    corpusClass: 'fte',
    seed,
    construction: '6 participants with weekday FTE profiles, 14 days; WeekdayFteLimit on sat and sun',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'fte',
      dayCount: 14,
      shiftTypes: [{ code: 'DAY' }],
      participants: Array.from({ length: 6 }, (_, index) => ({
        index,
        workPercentage: index < 3 ? 100 : 60,
        weekdayTargets: WEEK_FULL,
      })),
      uniformDemand: [['DAY', 1]],
      rules: [
        {
          ruleKey: 'fte-sat',
          classification: 'HARD',
          predicate: { kind: 'WeekdayFteLimit', weekday: 'sat', fteFraction: 1 },
        },
        {
          ruleKey: 'fte-sun',
          classification: 'HARD',
          predicate: { kind: 'WeekdayFteLimit', weekday: 'sun', fteFraction: 1 },
        },
      ],
    }),
  };
}

/**
 * `B-locum-shaped` — the SHAPE, through existing inputs, honestly named.
 *
 * There is no locum attribute a rule can read: `LocumRestriction` and
 * `StaffOverLocumPriority` are owned by the locum slice, and doc 35 §6d says so
 * — "data-not-modelled kinds stay failed-closed; the fixture proves the
 * fail-closed path, honestly named".
 *
 * So this fixture does NOT pretend to schedule locums. It poses a problem that
 * carries `staffingKind: 'locum'` participants and an ACTIVE HARD
 * `LocumRestriction` rule, and its recorded expectation is that the worker
 * **refuses to model it at all**, naming the kind and the owner. A build that
 * solved this problem would have silently ignored a HARD rule, which is the one
 * thing SPEC-04 §3.3 admits no path to.
 */
function locumShaped(): CorpusFixture {
  const seed = 'e1.locum';
  return {
    name: 'B-locum-shaped',
    corpusClass: 'locum-shaped',
    seed,
    construction:
      '4 participants (2 locum) and an ACTIVE HARD LocumRestriction — the worker must refuse, naming locum-slice',
    expectation: {
      outcome: 'worker-refused',
      status: 'FAILED',
      terminationReason: 'rejected',
      code: 'rule_kind_not_modelled',
    },
    document: buildSnapshot({
      seed,
      corpusClass: 'locum-shaped',
      dayCount: 5,
      shiftTypes: [{ code: 'DAY' }],
      participants: [
        { index: 0 },
        { index: 1 },
        { index: 2, staffingKind: 'locum' },
        { index: 3, staffingKind: 'locum' },
      ],
      uniformDemand: [['DAY', 1]],
      rules: [
        {
          ruleKey: 'lo-restriction',
          classification: 'HARD',
          predicate: { kind: 'LocumRestriction', restriction: 'locum_last_resort' },
        },
      ],
    }),
  };
}

/** `B-fairness-shaped` — SOFT rules become explicit E1 objective tiers, never constraints. */
function fairnessShaped(): CorpusFixture {
  const seed = 'e1.fairness';
  return {
    name: 'B-fairness-shaped',
    corpusClass: 'fairness-shaped',
    seed,
    construction: '6 participants, 7 days, DAY demand 2; four SOFT rules across three E1 tiers',
    expectation: { outcome: 'solved' },
    document: buildSnapshot({
      seed,
      corpusClass: 'fairness-shaped',
      dayCount: 7,
      shiftTypes: [{ code: 'DAY' }, { code: 'EVE', startTime: '16:00:00', endTime: '23:00:00' }],
      participants: Array.from({ length: 6 }, (_, index) => ({
        index,
        workPercentage: 100,
        weekdayTargets: WEEK_FULL,
      })),
      uniformDemand: [['DAY', 2]],
      rules: [
        {
          ruleKey: 'fa-preference',
          classification: 'SOFT',
          weight: '2.00',
          predicate: { kind: 'ShiftPreference', shiftType: 'DAY', strength: 'prefer' },
        },
        {
          ruleKey: 'fa-percentage',
          classification: 'SOFT',
          weight: '1.00',
          predicate: { kind: 'WorkPercentageTarget', targetPercentage: 40 },
        },
        {
          ruleKey: 'fa-balance',
          classification: 'SOFT',
          weight: '3.00',
          predicate: { kind: 'FairnessBalance', metric: 'assignments', normalisation: 'none' },
        },
        {
          ruleKey: 'fa-credits',
          classification: 'SOFT',
          weight: '1.00',
          predicate: { kind: 'CreditDistribution', metric: 'credits' },
        },
      ],
    }),
  };
}

/**
 * `B-infeasible-contradictory-rules` — two HARD rules that cannot both hold.
 *
 * `AUX` implies `EVE` on the same date and the two are mutually exclusive on
 * the same date, so nobody may take `AUX` at all — while the demand asks for one
 * every day. The cause is RULE-vs-RULE (RK-RULING-09 in both directions), which
 * is what makes the T1 assumption subset the interesting half of the answer.
 *
 * ## `EVE` is demanded too, and that is load-bearing
 *
 * The first version of this fixture demanded only `AUX`, and the corpus run
 * showed CP-SAT returning `['__demand__', 'ci-implies']` — a **smaller**
 * sufficient subset than the two rules, and a correct one: with no `EVE`
 * demand the coverage equality already forces every `EVE` cell to zero, so
 * `ci-implies` alone contradicted it and `ci-mutex` was never needed. The
 * fixture was contradictory, but not for the reason its class claims.
 *
 * Demanding `EVE` removes that shortcut. Each rule is now satisfiable with the
 * demand on its own — `ci-implies` alone lets one member take both;
 * `ci-mutex` alone lets two members split them — so **neither can be dropped**,
 * and the sufficient subset has to name both.
 */
function infeasibleContradictoryRules(): CorpusFixture {
  const seed = 'e1.infeasible.rules';
  return {
    name: 'B-infeasible-contradictory-rules',
    corpusClass: 'infeasible-contradictory-rules',
    seed,
    construction:
      'AUX implies EVE and AUX excludes EVE, both HARD, with BOTH demanded every day so neither rule alone suffices',
    expectation: {
      outcome: 'infeasible',
      conflictingRuleKeys: ['ci-implies', 'ci-mutex'],
    },
    document: buildSnapshot({
      seed,
      corpusClass: 'infeasible-contradictory-rules',
      dayCount: 3,
      shiftTypes: [
        { code: 'AUX', startTime: '10:00:00', endTime: '12:00:00' },
        { code: 'EVE', startTime: '16:00:00', endTime: '23:00:00' },
      ],
      participants: plainParticipants(4),
      uniformDemand: [
        ['AUX', 1],
        ['EVE', 1],
      ],
      rules: [
        {
          ruleKey: 'ci-implies',
          classification: 'HARD',
          predicate: { kind: 'ImpliesAssignment', ifShiftType: 'AUX', thenShiftType: 'EVE' },
        },
        {
          ruleKey: 'ci-mutex',
          classification: 'HARD',
          predicate: { kind: 'MutuallyExclusive', shiftTypes: ['AUX', 'EVE'] },
        },
      ],
    }),
  };
}

/**
 * `B-infeasible-missing-qualification` — nobody may work the only shift there is.
 *
 * The frozen eligibility verdict is what says so, and this fixture carries that
 * verdict rather than re-deriving it. T0 sees the consequence structurally —
 * demand with no eligible participant — which is EXACT: no amount of search
 * makes somebody eligible.
 */
function infeasibleMissingQualification(): CorpusFixture {
  const seed = 'e1.infeasible.qualification';
  return {
    name: 'B-infeasible-missing-qualification',
    corpusClass: 'infeasible-missing-qualification',
    seed,
    construction: 'DAY requires q-rare; no participant holds it, so the verdict says nobody is eligible',
    expectation: { outcome: 'infeasible', structuralCodes: ['no_eligible_member'] },
    document: buildSnapshot({
      seed,
      corpusClass: 'infeasible-missing-qualification',
      dayCount: 3,
      shiftTypes: [{ code: 'DAY', requiredQualificationKeys: ['q-rare'] }],
      qualificationKeys: ['q-rare'],
      participants: Array.from({ length: 3 }, (_, index) => ({ index, eligibleCodes: [] })),
      uniformDemand: [['DAY', 1]],
    }),
  };
}

/** `B-infeasible-over-demand` — more slots than there are people to fill them. */
function infeasibleOverDemand(): CorpusFixture {
  const seed = 'e1.infeasible.overdemand';
  return {
    name: 'B-infeasible-over-demand',
    corpusClass: 'infeasible-over-demand',
    seed,
    construction: '2 participants and a demand of 4 on every date',
    expectation: {
      outcome: 'infeasible',
      structuralCodes: ['eligible_capacity_below_demand', 'day_demand_exceeds_participants'],
    },
    document: buildSnapshot({
      seed,
      corpusClass: 'infeasible-over-demand',
      dayCount: 3,
      shiftTypes: [{ code: 'DAY' }],
      participants: plainParticipants(2),
      uniformDemand: [['DAY', 4]],
    }),
  };
}

/**
 * `B-infeasible-fixed-conflict` — two pins competing for one slot.
 *
 * Two participants are pinned onto the same date and shift type whose demand is
 * one, so the pins alone make the problem unsatisfiable. A third pin puts one
 * membership on two shift types on one date, which is what T0's
 * `conflicting_fixed_assignments` names — the fixture carries both so the
 * structural finding and the unsatisfiability are each exercised.
 */
function infeasibleFixedConflict(): CorpusFixture {
  const seed = 'e1.infeasible.fixed';
  const dates = datesFrom(DEFAULT_START, 3);
  const clash = dates[0] ?? DEFAULT_START;
  return {
    name: 'B-infeasible-fixed-conflict',
    corpusClass: 'infeasible-fixed-conflict',
    seed,
    construction: 'two pins on one DAY slot of demand 1, plus one membership pinned to two types on one date',
    expectation: {
      outcome: 'infeasible',
      structuralCodes: ['conflicting_fixed_assignments'],
    },
    document: buildSnapshot({
      seed,
      corpusClass: 'infeasible-fixed-conflict',
      dayCount: 3,
      shiftTypes: [{ code: 'DAY' }, { code: 'EVE', startTime: '16:00:00', endTime: '23:00:00' }],
      participants: plainParticipants(3),
      uniformDemand: [
        ['DAY', 1],
        ['EVE', 1],
      ],
      fixed: [
        { label: 'clash-a', participantIndex: 0, date: clash, code: 'DAY' },
        { label: 'clash-b', participantIndex: 1, date: clash, code: 'DAY' },
        { label: 'clash-c', participantIndex: 0, date: clash, code: 'EVE' },
      ],
    }),
  };
}

/** Every fixture this module generates, except the race-produced one. */
export function generatedCorpus(): readonly CorpusFixture[] {
  return [
    feasibleSmall(),
    feasibleMedium(),
    feasibleLarge(),
    multisite(),
    ruleHeavy(),
    progressivePinned(),
    qualifications(),
    fte(),
    locumShaped(),
    fairnessShaped(),
    infeasibleContradictoryRules(),
    infeasibleMissingQualification(),
    infeasibleOverDemand(),
    infeasibleFixedConflict(),
  ];
}

/**
 * **A deliberately expensive problem**, for the lifecycle proofs — not a corpus
 * class and not part of the manifest.
 *
 * S-05t/S-06t/S-07t have to be re-proven against the REAL solve, and every one
 * of them needs a solve that is still running when the parent does something to
 * it. The stub had a `dwell` behaviour for that; CP-SAT has no such switch, so
 * the difficulty has to be genuine.
 *
 * It comes from OPTIMISATION rather than from size alone. A `FairnessBalance`
 * term minimises the spread between the busiest and the least busy member across
 * `participants × days × shift types` boolean cells, and proving THAT optimal is
 * far harder than finding a feasible schedule — which is exactly the shape a
 * deadline is meant to cut short. The capacity and rest rules on top give the
 * search something to do rather than letting presolve close it.
 *
 * Deliberately NOT in the corpus: it has no constructed cause and no expected
 * outcome, because its outcome depends on the budget it is given. Putting a
 * fixture whose answer is "it depends" into a corpus that asserts answers would
 * make the corpus mean less.
 */
export function hardOptimisationProblem(): SolverInputSnapshotDocument {
  const seed = 'e1.lifecycle.hard';
  return buildSnapshot({
    seed,
    corpusClass: 'feasible-large',
    dayCount: 84,
    shiftTypes: [
      { code: 'DAY' },
      { code: 'EVE', startTime: '16:00:00', endTime: '23:00:00' },
      { code: 'NGT', startTime: '23:00:00', endTime: '07:00:00', crossesMidnight: true },
      { code: 'CAL', startTime: '18:00:00', endTime: '20:00:00', isOnCall: true },
    ],
    participants: Array.from({ length: 26 }, (_, index) => ({
      index,
      workPercentage: 100,
      weekdayTargets: WEEK_FULL,
    })),
    uniformDemand: [
      ['DAY', 3],
      ['EVE', 2],
      ['NGT', 2],
      ['CAL', 1],
    ],
    rules: [
      { ruleKey: 'hd-consecutive', classification: 'HARD', predicate: { kind: 'MaxConsecutive', maxDays: 4 } },
      {
        ruleKey: 'hd-window',
        classification: 'HARD',
        predicate: { kind: 'MaxAssignmentsInWindow', max: 5, windowDays: 7 },
      },
      { ruleKey: 'hd-rest', classification: 'HARD', predicate: { kind: 'MinimumRestBetween', minHours: 10 } },
      {
        ruleKey: 'hd-callspacing',
        classification: 'HARD',
        predicate: { kind: 'CallSpacing', minDaysBetweenCalls: 3 },
      },
      {
        ruleKey: 'hd-fairness',
        classification: 'SOFT',
        weight: '5.00',
        predicate: { kind: 'FairnessBalance', metric: 'assignments', normalisation: 'none' },
      },
      {
        ruleKey: 'hd-credits',
        classification: 'SOFT',
        weight: '3.00',
        predicate: { kind: 'CreditDistribution', metric: 'credits' },
      },
      {
        ruleKey: 'hd-percentage',
        classification: 'SOFT',
        weight: '2.00',
        predicate: { kind: 'WorkPercentageTarget', targetPercentage: 45 },
      },
    ],
  });
}

/**
 * **The rest-across-a-GAP-DAY problem** (FAD-42 R-1).
 *
 * Three dates, one participant, demand on the FIRST and THIRD date and **none
 * on the second**. The only demand-satisfying schedule therefore straddles a
 * demand-free day: a `DAY` shift on date 1 ending 16:00 and a `DAY` shift on
 * date 3 starting 08:00, which is **40.00 hours of rest**.
 *
 * That number is the whole point. It sits either side of the thresholds the pin
 * uses, so a single `minHours` knob decides whether the schedule is legal:
 *
 * | `minHours` | Legal? | Both implementations must say |
 * |---|---|---|
 * | 30 | yes — 40 ≥ 30 | model solves it, checker finds no breach |
 * | 41 | no — 40 < 41 | model INFEASIBLE, checker breaches the only candidate |
 *
 * The model used to pair each date only with the NEXT one, so the date-1 ↔
 * date-3 pair was never posted and `minHours = 41` came back OPTIMAL with a
 * candidate the checker then refused. Deliberately NOT a corpus fixture: it is
 * parameterised, and a corpus entry asserts one answer.
 */
export function restAcrossGapDayProblem(minHours: number): SolverInputSnapshotDocument {
  const seed = 'e1.rest.gapday';
  const dates = datesFrom(DEFAULT_START, 3);
  const first = dates[0] ?? DEFAULT_START;
  const third = dates[2] ?? DEFAULT_START;
  return buildSnapshot({
    seed,
    corpusClass: 'feasible-small',
    dayCount: 3,
    shiftTypes: [{ code: 'DAY' }],
    participants: [{ index: 0, workPercentage: 100, weekdayTargets: WEEK_FULL }],
    // Demand on dates 1 and 3 only. Date 2 is the gap day, and its absence from
    // this list is what makes the 40-hour rest the ONLY option rather than one
    // option among several.
    demand: [
      [first, 'DAY', 1],
      [third, 'DAY', 1],
    ],
    rules: [
      {
        ruleKey: 'gap-rest',
        classification: 'HARD',
        predicate: { kind: 'MinimumRestBetween', minHours },
      },
    ],
  });
}

/**
 * **A HARD rule scoped to a staff group that resolves to NOBODY** (FAD-42 R-6).
 *
 * One participant, two dates, demand on both, and one HARD `AvoidDate` rule on
 * the first date — a rule that WOULD make the problem infeasible if it applied
 * to anyone. Its scope names a staff group, and the two modes differ only in
 * which id that is:
 *
 * | Mode | The named group | Ruled behaviour (FAD-42(3)) |
 * |---|---|---|
 * | `known-empty` | exists in the snapshot, has NO members | the rule binds nobody, so it **satisfies vacuously** — the RK-RULING-04 class: an empty scope makes no statement |
 * | `unknown` | is not a staff-group id at all | **blocks** — a scope that cannot be resolved narrows to an unknown subset, and a rule evaluated over an unknown subset is a rule evaluated over the wrong one |
 *
 * The difference matters because at base BOTH blocked, and only because the kind
 * was wholly not-evaluable — an accident of coverage, never a semantic. Pinning
 * both directions is what turns the shipped behaviour into a decision.
 */
export function emptyStaffGroupScopeProblem(
  mode: 'known-empty' | 'unknown',
): SolverInputSnapshotDocument {
  const seed = 'e1.scope.emptygroup';
  const dates = datesFrom(DEFAULT_START, 2);
  const scopedGroupId =
    mode === 'known-empty'
      ? corpusId(seed, 'staffGroup:nobody')
      : corpusId(seed, 'staffGroup:not-a-group-at-all');
  return buildSnapshot({
    seed,
    corpusClass: 'feasible-small',
    dayCount: 2,
    shiftTypes: [{ code: 'DAY' }],
    participants: [{ index: 0, workPercentage: 100, weekdayTargets: WEEK_FULL }],
    uniformDemand: [['DAY', 1]],
    // Declared with NO members. In `unknown` mode the rule below names a
    // different id entirely, so this group exists either way and the ONLY
    // variable is whether the scope resolves.
    staffGroups: [['nobody', []]],
    rules: [
      {
        ruleKey: 'scope-empty-group',
        classification: 'HARD',
        scope: { staffGroups: [scopedGroupId] },
        predicate: { kind: 'AvoidDate', date: dates[0] ?? DEFAULT_START },
      },
    ],
  });
}
