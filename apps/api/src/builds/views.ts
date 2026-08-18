import type {
  BuildConflict,
  BuildExplanation,
  BuildFinding,
  BuildQualityMetrics,
  BuildRejection,
  BuildResult,
  BuildRunEvent,
  BuildRunSummary,
  BuildViolation,
  CandidateComparisonRow,
  Comparability,
  ObjectiveTier,
} from '@schedulepoint/contracts';
import { resultsAreComparable, type UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { BuildRunState, Database } from '../db/schema.js';
import { calendarDate } from '../schedule/render.js';
import { conflictsOf } from './conflicts.js';
import type { BuildRunRow } from './service.js';

/**
 * The build lifecycle's READ projections (OPUS-M4-003).
 *
 * ## Nothing here decides anything
 *
 * Every function is a shape change over rows somebody else wrote. In particular
 * the comparison (D-4c) is a **read-only projection over completed candidates**
 * and is not allowed to become a ranking: SPEC-04 §7 says every quality band
 * except `hard_violations = 0` is undefined until the benchmark corpus is run,
 * so a "best candidate" here would be an invented threshold wearing a number's
 * clothes. It reports what differs and what each candidate measured; the
 * scheduler decides.
 */

type Uow = UnitOfWork<Kysely<Database>>;

export function summaryOf(
  run: BuildRunRow,
  configurationName: string,
  retryLimit: number,
): BuildRunSummary {
  return {
    id: run.id,
    periodId: run.period_id,
    configurationId: run.build_configuration_id,
    configurationName,
    candidateLabel: run.candidate_label,
    sourceVersionId: run.source_version_id,
    state: run.state,
    solverStatus: run.solver_status,
    terminationReason: run.termination_reason,
    canonicalInputHash: run.canonical_input_hash,
    claimEpoch: run.claim_epoch,
    heartbeatAt: run.heartbeat_at === null ? null : run.heartbeat_at.toISOString(),
    retryOfBuildRunId: run.retry_of_build_run_id,
    retryAttempt: run.retry_attempt,
    retryLimit,
    parentBuildIds: [...run.parent_build_ids],
    appliedToVersionId: run.applied_to_version_id,
    supersededByBuildRunId: run.superseded_by_build_run_id,
    createdAt: run.created_at.toISOString(),
    updatedAt: run.updated_at.toISOString(),
  };
}

/** Findings are stored as jsonb; they are re-read defensively, never trusted blind. */
export function findingsOf(value: unknown): BuildFinding[] {
  if (!Array.isArray(value)) return [];
  const out: BuildFinding[] = [];
  for (const entry of value) {
    const row = entry as Partial<BuildFinding>;
    if (typeof row.code !== 'string' || typeof row.detail !== 'string') continue;
    out.push({
      code: row.code,
      tier: row.tier === 'T0' || row.tier === 'assembly' ? row.tier : 'configuration',
      date: typeof row.date === 'string' ? row.date : null,
      shiftTypeId: typeof row.shiftTypeId === 'string' ? row.shiftTypeId : null,
      detail: row.detail,
    });
  }
  return out;
}

export interface RunDetailRows {
  readonly result: BuildResult | null;
  readonly violations: readonly BuildViolation[];
  /** PO-DEC-13's classified, severity-ordered projection over everything above. */
  readonly conflicts: readonly BuildConflict[];
  readonly events: readonly BuildRunEvent[];
}

/** The persisted fairness extremes, read defensively. Advisory, never banded. */
function fairnessOutliersOf(value: unknown): readonly {
  membershipId: string;
  normalisedCredit: number;
  position: 'highest' | 'lowest';
}[] {
  const row = (value ?? {}) as Record<string, unknown>;
  const raw = row['fairnessOutliers'];
  if (!Array.isArray(raw)) return [];
  const out: { membershipId: string; normalisedCredit: number; position: 'highest' | 'lowest' }[] =
    [];
  for (const entry of raw.slice(0, 8)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const membershipId = item['membershipId'];
    const normalisedCredit = item['normalisedCredit'];
    const position = item['position'];
    if (!isString(membershipId)) continue;
    if (typeof normalisedCredit !== 'number' || !Number.isFinite(normalisedCredit)) continue;
    if (position !== 'highest' && position !== 'lowest') continue;
    out.push({ membershipId, normalisedCredit, position });
  }
  return out;
}

export async function readRunDetail(uow: Uow, buildRunId: string): Promise<RunDetailRows> {
  const resultRow = await uow.query
    .selectFrom('build_run_results')
    .selectAll()
    .where('build_run_id', '=', buildRunId)
    .executeTakeFirst();

  const violationRows = await uow.query
    .selectFrom('build_run_violations')
    .select(['finding', 'rule_key', 'node_kind', 'field', 'explanation'])
    .where('build_run_id', '=', buildRunId)
    .orderBy('rule_key')
    .orderBy('field')
    .execute();

  const eventRows = await uow.query
    .selectFrom('build_run_events')
    .select([
      'kind',
      'from_state',
      'to_state',
      'claim_epoch',
      'current_claim_epoch',
      'reason',
      'occurred_at',
    ])
    .where('build_run_id', '=', buildRunId)
    .orderBy('occurred_at')
    .execute();

  const violations: BuildViolation[] = violationRows.map((row) => ({
    finding: row.finding,
    ruleKey: row.rule_key,
    nodeKind: row.node_kind,
    field: row.field,
    explanation: row.explanation,
  }));

  const result: BuildResult | null =
    resultRow === undefined
      ? null
      : {
          solverStatus: resultRow.solver_status,
          terminationReason: resultRow.termination_reason,
          usable: resultRow.usable,
          candidateReturned: resultRow.candidate_returned,
          assignmentCount: resultRow.assignment_count,
          objectiveValue:
            resultRow.objective_value === null ? null : Number(resultRow.objective_value),
          elapsedMs: resultRow.elapsed_ms,
          quality: qualityOf(resultRow.quality_metrics, resultRow.hard_violations),
          objectiveTiers: objectiveTiersOf(resultRow.objective_tiers),
          explanation: explanationOf(resultRow.explanation, resultRow.explanation_state),
          rejections: rejectionsOf(resultRow.rejections),
        };

  return {
    result,
    violations,
    /* Derived on READ (see `conflicts.ts`): a display rule that changes should
     * re-classify history, and a stored class would freeze each build under
     * whatever the taxonomy said the day it ran. */
    conflicts: conflictsOf({
      violations,
      rejections: result?.rejections ?? [],
      explanation: result?.explanation ?? null,
      quality: result?.quality ?? null,
      fairnessOutliers:
        resultRow === undefined ? [] : fairnessOutliersOf(resultRow.quality_metrics),
    }),
    events: eventRows.map((row) => ({
      kind: row.kind,
      fromState: (row.from_state as BuildRunState | null) ?? null,
      toState: (row.to_state as BuildRunState | null) ?? null,
      claimEpoch: row.claim_epoch,
      currentClaimEpoch: row.current_claim_epoch,
      reason: row.reason,
      occurredAt: row.occurred_at.toISOString(),
    })),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function qualityOf(value: unknown, hardViolations: number): BuildQualityMetrics {
  const row = (value ?? {}) as Record<string, unknown>;
  const statistics: Record<string, number | null> = {};
  const rawStatistics = row['solverStatistics'];
  if (typeof rawStatistics === 'object' && rawStatistics !== null) {
    for (const [key, raw] of Object.entries(rawStatistics as Record<string, unknown>)) {
      statistics[key] = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    }
  }
  const digest = row['objectiveWeightsDigest'];
  return {
    demandSatisfactionRate: numberOrNull(row['demandSatisfactionRate']),
    requiredSlots: numberOrNull(row['requiredSlots']) ?? 0,
    filledSlots: numberOrNull(row['filledSlots']) ?? 0,
    /* The COLUMN's count, never the jsonb's. `hard_violations` is a constrained
     * column the `usable` CHECK is written against; the metrics bag beside it is
     * free-form. Two spellings of one number, and the constrained one wins. */
    hardViolations,
    softPenaltyTotal: numberOrNull(row['softPenaltyTotal']),
    solveWallClockMs: numberOrNull(row['solveWallClockMs']) ?? 0,
    requestHonourRate: numberOrNull(row['requestHonourRate']),
    templateAdherenceRate: numberOrNull(row['templateAdherenceRate']),
    fairnessDispersion: numberOrNull(row['fairnessDispersion']),
    /* An unrecorded basis reads as `unrecorded`, not as the current default: a
     * result written before the basis was recorded did not use today's. */
    fairnessNormalisation: isString(row['fairnessNormalisation'])
      ? row['fairnessNormalisation']
      : 'unrecorded',
    fairnessMeasuredParticipants: numberOrNull(row['fairnessMeasuredParticipants']) ?? 0,
    fairnessUnmeasuredParticipants: numberOrNull(row['fairnessUnmeasuredParticipants']) ?? 0,
    explanationLatencyMs: numberOrNull(row['explanationLatencyMs']),
    objectiveWeightsDigest: isString(digest) && /^[0-9a-f]{64}$/.test(digest) ? digest : null,
    objectiveScale: numberOrNull(row['objectiveScale']) ?? 0,
    objectiveProfileId: isString(row['objectiveProfileId']) ? row['objectiveProfileId'] : '',
    solverStatistics: statistics,
  };
}

function objectiveTiersOf(value: unknown): ObjectiveTier[] {
  if (!Array.isArray(value)) return [];
  const out: ObjectiveTier[] = [];
  for (const entry of value) {
    const row = entry as Partial<ObjectiveTier>;
    if (typeof row.tier !== 'number' || typeof row.name !== 'string') continue;
    out.push({
      tier: row.tier,
      name: row.name,
      weightScale: typeof row.weightScale === 'number' ? row.weightScale : 0,
      /* A tier recorded before the scale was carried reads `1` rather than the
       * current constant: claiming today's factor for yesterday's row is the
       * mis-recording the single-sourcing exists to prevent. */
      scale: typeof row.scale === 'number' && row.scale > 0 ? row.scale : 1,
      ruleKeys: Array.isArray(row.ruleKeys) ? row.ruleKeys.filter(isString) : [],
      components: Array.isArray(row.components)
        ? row.components.filter(
            (component): component is { ruleKey: string; scaledWeight: number } =>
              typeof component === 'object' &&
              component !== null &&
              typeof (component as { ruleKey?: unknown }).ruleKey === 'string' &&
              typeof (component as { scaledWeight?: unknown }).scaledWeight === 'number',
          )
        : [],
      unmappedRuleKeys: Array.isArray(row.unmappedRuleKeys)
        ? row.unmappedRuleKeys.filter(isString)
        : [],
      termCount: typeof row.termCount === 'number' ? row.termCount : 0,
    });
  }
  return out;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function explanationOf(value: unknown, state: string | null): BuildExplanation {
  const row = (value ?? {}) as Record<string, unknown>;
  const structural = Array.isArray(row['structural']) ? row['structural'] : [];
  const tier2 = row['tier2'];
  return {
    state: isExplanationState(state) ? state : null,
    structural: structuralFindingsOf(structural),
    conflictingRuleKeys: Array.isArray(row['conflictingRuleKeys'])
      ? row['conflictingRuleKeys'].filter(isString)
      : [],
    tier2:
      typeof tier2 === 'object' && tier2 !== null
        ? {
            attempted: (tier2 as Record<string, unknown>)['attempted'] === true,
            iterations: numberOrNull((tier2 as Record<string, unknown>)['iterations']) ?? 0,
            removed: numberOrNull((tier2 as Record<string, unknown>)['removed']) ?? 0,
            budgetSeconds: numberOrNull((tier2 as Record<string, unknown>)['budgetSeconds']) ?? 0,
            maxIterations: numberOrNull((tier2 as Record<string, unknown>)['maxIterations']) ?? 0,
            exhausted: (tier2 as Record<string, unknown>)['exhausted'] === true,
          }
        : null,
    solveCount: numberOrNull(row['solveCount']),
    elapsedSeconds: numberOrNull(row['elapsedSeconds']),
  };
}

function structuralFindingsOf(entries: readonly unknown[]): BuildFinding[] {
  const out: BuildFinding[] = [];
  for (const entry of entries) {
    const finding = entry as Record<string, unknown>;
    const code = finding['code'];
    const detail = finding['detail'];
    if (typeof code !== 'string' || typeof detail !== 'string') continue;
    out.push({
      code,
      tier: 'T0',
      date: typeof finding['date'] === 'string' ? finding['date'] : null,
      shiftTypeId: typeof finding['shiftTypeId'] === 'string' ? finding['shiftTypeId'] : null,
      detail,
    });
  }
  return out;
}

const EXPLANATION_STATES = new Set([
  'EXPLAINED_EXACT',
  'EXPLAINED_SUBSET',
  'EXPLAINED_MINIMAL',
  'EXPLANATION_BUDGET_EXCEEDED',
  'EXPLANATION_UNAVAILABLE',
]);

function isExplanationState(value: string | null): value is BuildExplanation['state'] & string {
  return value !== null && EXPLANATION_STATES.has(value);
}

/** Exported for the F-14 pin: the read path is where a reason goes missing. */
export function rejectionsOf(value: unknown): BuildRejection[] {
  if (!Array.isArray(value)) return [];
  const out: BuildRejection[] = [];
  for (const entry of value) {
    const row = entry as Record<string, unknown>;
    const reason = row['reason'];
    const detail = row['detail'];
    if (typeof reason !== 'string' || typeof detail !== 'string') continue;
    if (
      reason !== 'input-hash-mismatch' &&
      reason !== 'unknown-reference' &&
      reason !== 'duplicate-assignment' &&
      reason !== 'ineligible-assignment' &&
      reason !== 'protected-assignment-dropped' &&
      /* F-14: every reason `CandidateRejection` can produce must appear here.
         This allowlist FAILS CLOSED — an unlisted reason is `continue`d away —
         which is right for a forged row and catastrophic for a real one, because
         the candidate is still refused and the screen now says why: nothing. */
      reason !== 'demand-not-met' &&
      reason !== 'hard-violation'
    ) {
      continue;
    }
    out.push({ reason, detail: detail.slice(0, 2000) });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * D-4c — the comparison projection
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ComparisonProjection {
  readonly differences: readonly CandidateComparisonRow[];
  readonly sharedAssignmentCount: number;
  readonly comparability: Comparability;
}

/**
 * **Comparability, enforced** (OPUS-M4-004; doc 35 §6f required behaviour 1).
 *
 * > two results are comparable iff same snapshot + same weights, and the
 * > comparison service enforces exactly that.
 *
 * `resultsAreComparable` is the domain's decision and it is the ONE decision;
 * this function only supplies the facts. Both halves matter and neither is
 * sufficient:
 *
 *  * **same snapshot** — two candidates for different problems are answers about
 *    different periods, and their placement differences are coincidences;
 *  * **same weights** — two candidates under different objectives are answers to
 *    different questions, and their objective values are not on one axis.
 *
 * A missing hash or a missing digest is NOT a wildcard. It is exactly the case
 * where nobody can tell, and "cannot tell" must not render as "yes".
 */
export async function comparabilityOf(
  uow: Uow,
  buildRunIds: readonly string[],
): Promise<Comparability> {
  if (buildRunIds.length < 2) return { comparable: true };

  const rows = await uow.query
    .selectFrom('build_runs')
    .leftJoin('build_run_results', 'build_run_results.build_run_id', 'build_runs.id')
    .select([
      'build_runs.id as id',
      'build_runs.canonical_input_hash as canonical_input_hash',
      'build_run_results.quality_metrics as quality_metrics',
    ])
    .where('build_runs.id', 'in', [...buildRunIds])
    .execute();

  const byId = new Map(rows.map((row) => [row.id, row]));
  const facts = buildRunIds.map((id) => {
    const row = byId.get(id);
    const metrics = (row?.quality_metrics ?? {}) as Record<string, unknown>;
    const digest = metrics['objectiveWeightsDigest'];
    return {
      canonicalInputHash: row?.canonical_input_hash ?? null,
      objectiveWeightsDigest: isString(digest) && /^[0-9a-f]{64}$/.test(digest) ? digest : null,
    };
  });

  return resultsAreComparable(facts);
}

/**
 * Compare candidates by PLACEMENT, over the ordered run ids the caller asked
 * for.
 *
 * Only the rows that DIFFER are returned. A full agreement projection is the
 * empty list, and reporting a thousand identical placements to show that two
 * candidates agree would bury the six that do not — which is the whole question
 * a comparison is asked.
 */
export async function compareCandidates(
  uow: Uow,
  buildRunIds: readonly string[],
): Promise<ComparisonProjection> {
  if (buildRunIds.length === 0) {
    return { differences: [], sharedAssignmentCount: 0, comparability: { comparable: true } };
  }

  /* The gate comes FIRST and the projection is not computed at all when it
   * refuses. Computing it anyway and letting the client decide whether to render
   * it would leave a difference list — over two different problems — sitting in
   * a response, one careless read away from a column. */
  const comparability = await comparabilityOf(uow, buildRunIds);
  if (!comparability.comparable) {
    return { differences: [], sharedAssignmentCount: 0, comparability };
  }

  const rows = await uow.query
    .selectFrom('build_run_candidate_assignments')
    .innerJoin('build_runs', 'build_runs.id', 'build_run_candidate_assignments.build_run_id')
    .select([
      'build_run_candidate_assignments.build_run_id as build_run_id',
      'build_run_candidate_assignments.membership_id as membership_id',
      'build_run_candidate_assignments.date as date',
      'build_run_candidate_assignments.shift_type_id as shift_type_id',
    ])
    /* Only rows at each run's CURRENT claim epoch. A reaped-and-rerun build has
     * candidate rows from a superseded claim; comparing against those would be
     * comparing against an answer the system already refused. */
    .whereRef('build_run_candidate_assignments.claim_epoch', '=', 'build_runs.claim_epoch')
    .where('build_run_candidate_assignments.build_run_id', 'in', [...buildRunIds])
    .execute();

  const byPlacement = new Map<
    string,
    { membershipId: string; date: string; shiftTypeId: string; runs: Set<string> }
  >();
  for (const row of rows) {
    /* The driver returns a `Date` for a `date` column; `calendarDate` is the one
     * normalisation, so a comparison key here and a rendered date elsewhere can
     * never disagree about which day a placement is on. */
    const date = calendarDate(row.date);
    const key = `${row.membership_id}|${date}|${row.shift_type_id}`;
    const entry = byPlacement.get(key) ?? {
      membershipId: row.membership_id,
      date,
      shiftTypeId: row.shift_type_id,
      runs: new Set<string>(),
    };
    entry.runs.add(row.build_run_id);
    byPlacement.set(key, entry);
  }

  const differences: CandidateComparisonRow[] = [];
  let shared = 0;
  for (const entry of [...byPlacement.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.shiftTypeId.localeCompare(b.shiftTypeId) ||
      a.membershipId.localeCompare(b.membershipId),
  )) {
    if (entry.runs.size === buildRunIds.length) {
      shared += 1;
      continue;
    }
    differences.push({
      membershipId: entry.membershipId,
      date: entry.date,
      shiftTypeId: entry.shiftTypeId,
      inRunIds: buildRunIds.filter((id) => entry.runs.has(id)),
    });
  }

  return { differences, sharedAssignmentCount: shared, comparability };
}
