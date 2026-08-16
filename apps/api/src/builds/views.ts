import type {
  BuildExplanation,
  BuildFinding,
  BuildQualityMetrics,
  BuildRejection,
  BuildResult,
  BuildRunEvent,
  BuildRunSummary,
  BuildViolation,
  CandidateComparisonRow,
  ObjectiveTier,
} from '@schedulepoint/contracts';
import type { UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { BuildRunState, Database } from '../db/schema.js';
import { calendarDate } from '../schedule/render.js';
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
  readonly events: readonly BuildRunEvent[];
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

  return {
    result:
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
          },
    violations: violationRows.map((row) => ({
      finding: row.finding,
      ruleKey: row.rule_key,
      nodeKind: row.node_kind,
      field: row.field,
      explanation: row.explanation,
    })),
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
  return {
    demandSatisfactionRate: numberOrNull(row['demandSatisfactionRate']),
    requiredSlots: numberOrNull(row['requiredSlots']) ?? 0,
    filledSlots: numberOrNull(row['filledSlots']) ?? 0,
    hardViolations,
    softPenaltyTotal: numberOrNull(row['softPenaltyTotal']),
    solveWallClockMs: numberOrNull(row['solveWallClockMs']) ?? 0,
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
      ruleKeys: Array.isArray(row.ruleKeys) ? row.ruleKeys.filter(isString) : [],
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
  return {
    state: isExplanationState(state) ? state : null,
    structural: structuralFindingsOf(structural),
    conflictingRuleKeys: Array.isArray(row['conflictingRuleKeys'])
      ? row['conflictingRuleKeys'].filter(isString)
      : [],
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

function rejectionsOf(value: unknown): BuildRejection[] {
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
  if (buildRunIds.length === 0) return { differences: [], sharedAssignmentCount: 0 };

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
    .whereRef(
      'build_run_candidate_assignments.claim_epoch',
      '=',
      'build_runs.claim_epoch',
    )
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

  return { differences, sharedAssignmentCount: shared };
}
