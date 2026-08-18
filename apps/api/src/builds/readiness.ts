import type { BuildFinding } from '@schedulepoint/contracts';
import type { SolverInputSnapshotDocument } from '@schedulepoint/domain';

/**
 * **The readiness check — SPEC-04 §5's T0, run before a solve is spent**
 * (doc 35 §6e Required behaviour 2: "readiness-checked (T0 structural findings
 * surface HERE per SPEC-04 §5, before queueing)").
 *
 * ## Why the same class of check exists in two places
 *
 * The worker also runs T0, on the way OUT of an infeasible solve, to explain it.
 * This runs on the way IN, to avoid spending one. They are the same structural
 * facts asked at two moments, and SPEC-04 §5 describes T0 as "always attempted"
 * and "exact when it fires" — which is precisely what makes it safe to act on
 * before the solve: a required slot with no eligible participant is not a
 * prediction about infeasibility, it is infeasibility, already proven, in
 * milliseconds.
 *
 * The duplication is therefore deliberate and is PROVEN rather than assumed:
 * `outcome-and-readiness.test.ts` builds a snapshot for each finding class and asserts that
 * this pass and the worker's `structural_findings` name the same codes. The
 * codes below are the worker's own tokens for that reason — a scheduler who sees
 * `no_eligible_member` at readiness and `no_eligible_member` in an explanation
 * is looking at one fact, not two.
 *
 * ## What it does NOT do
 *
 * It does not evaluate a single rule. Rule satisfaction is a solve, and a
 * readiness check that started guessing at it would either be wrong or be the
 * solver. Rules reach the build through the canonical input; a HARD rule that
 * cannot be evaluated is FAD-27's problem and surfaces at validation of the
 * candidate, not here.
 *
 * ## Demand is period requirements, and only those
 *
 * Exactly as the worker reads it: weekday defaults are the TEMPLATE a period is
 * generated from, and counting them as demand would invent requirement rows the
 * period does not have. Absence means zero.
 */

/** Every date in the inclusive range. Pure string arithmetic, no zone. */
function datesBetween(from: string, to: string): readonly string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (let ms = start; ms <= end; ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The structural findings, in a stable order (by code, then date, then shift
 * type) so that two runs over the same snapshot produce byte-identical output —
 * which is what makes the itemised list comparable across a retry.
 */
export function readinessFindings(
  snapshot: SolverInputSnapshotDocument,
): readonly BuildFinding[] {
  const findings: BuildFinding[] = [];

  const eligible = new Set<string>();
  for (const participant of snapshot.participants) {
    for (const verdict of participant.eligibility) {
      if (verdict.eligible) eligible.add(`${participant.membershipId}\x00${verdict.shiftTypeId}`);
    }
  }
  const participantIds = snapshot.participants.map((p) => p.membershipId);
  const knownShiftTypes = new Set(snapshot.shiftTypes.map((s) => s.shiftTypeId));
  const periodDates = new Set(datesBetween(snapshot.startDate, snapshot.endDate));

  /* Demand, resolved the way the model resolves it. */
  const required = new Map<string, { date: string; shiftTypeId: string; count: number }>();
  for (const cell of snapshot.demand) {
    if (cell.source !== 'period-requirement') continue;
    if (!Number.isInteger(cell.requiredCount)) continue;
    required.set(`${cell.on}\x00${cell.shiftTypeId}`, {
      date: cell.on,
      shiftTypeId: cell.shiftTypeId,
      count: cell.requiredCount,
    });
  }

  const byDay = new Map<string, number>();

  for (const cell of [...required.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.shiftTypeId.localeCompare(b.shiftTypeId),
  )) {
    if (cell.count <= 0) continue;
    byDay.set(cell.date, (byDay.get(cell.date) ?? 0) + cell.count);

    /* A requirement naming a shift type or a date the snapshot does not carry is
     * not a capacity problem — it is an inconsistent problem statement, and
     * saying so is more useful than reporting zero eligible participants for a
     * shift type that does not exist. */
    if (!knownShiftTypes.has(cell.shiftTypeId)) {
      findings.push({
        code: 'requirement_shift_type_unknown',
        tier: 'T0',
        date: cell.date,
        shiftTypeId: cell.shiftTypeId,
        detail: 'a period requirement names a shift type this snapshot does not carry',
      });
      continue;
    }
    if (!periodDates.has(cell.date)) {
      findings.push({
        code: 'requirement_outside_period',
        tier: 'T0',
        date: cell.date,
        shiftTypeId: cell.shiftTypeId,
        detail: "a period requirement is dated outside the period's own range",
      });
      continue;
    }

    const eligibleCount = participantIds.filter((membershipId) =>
      eligible.has(`${membershipId}\x00${cell.shiftTypeId}`),
    ).length;

    if (eligibleCount === 0) {
      findings.push({
        code: 'no_eligible_member',
        tier: 'T0',
        date: cell.date,
        shiftTypeId: cell.shiftTypeId,
        detail: `demand is ${String(cell.count)} and no participant is eligible`,
      });
    } else if (eligibleCount < cell.count) {
      findings.push({
        code: 'eligible_capacity_below_demand',
        tier: 'T0',
        date: cell.date,
        shiftTypeId: cell.shiftTypeId,
        detail: `demand is ${String(cell.count)} and ${String(eligibleCount)} participants are eligible`,
      });
    }
  }

  for (const date of [...byDay.keys()].sort()) {
    const demand = byDay.get(date) ?? 0;
    if (demand > participantIds.length) {
      findings.push({
        code: 'day_demand_exceeds_participants',
        tier: 'T0',
        date,
        shiftTypeId: null,
        detail: `demand is ${String(demand)} across ${String(participantIds.length)} participants`,
      });
    }
  }

  /* Contradictory fixed inputs. Two pins on one membership on one date is a
   * statement the solver cannot satisfy and did not choose. */
  const placed = new Map<string, string>();
  for (const fixed of [...snapshot.fixedAssignments].sort(
    (a, b) =>
      a.membershipId.localeCompare(b.membershipId) ||
      a.date.localeCompare(b.date) ||
      a.shiftTypeId.localeCompare(b.shiftTypeId),
  )) {
    const key = `${fixed.membershipId}\x00${fixed.date}`;
    const already = placed.get(key);
    if (already !== undefined && already !== fixed.shiftTypeId) {
      findings.push({
        code: 'conflicting_fixed_assignments',
        tier: 'T0',
        date: fixed.date,
        shiftTypeId: fixed.shiftTypeId,
        detail: 'two fixed inputs place one membership on one date',
      });
    }
    placed.set(key, fixed.shiftTypeId);
  }

  return findings;
}

/**
 * The configuration-level validation `draft_configuration → validating` runs.
 *
 * Report 21's guard is "scope non-empty", and this is what non-empty means for a
 * build: there is a period, there is something to staff, and there is somebody
 * who could staff it. All three are checked against the SNAPSHOT rather than the
 * request, because a request can name a period that turns out to be empty and a
 * scheduler needs to be told which of the three is missing.
 */
export function configurationFindings(
  snapshot: SolverInputSnapshotDocument,
): readonly BuildFinding[] {
  const findings: BuildFinding[] = [];

  if (snapshot.shiftTypes.length === 0) {
    findings.push({
      code: 'no_shift_types',
      tier: 'configuration',
      date: null,
      shiftTypeId: null,
      detail: 'this group has no shift types, so there is nothing for a build to place',
    });
  }
  if (snapshot.participants.length === 0) {
    findings.push({
      code: 'no_participants',
      tier: 'configuration',
      date: null,
      shiftTypeId: null,
      detail: 'this period has no active effective participants',
    });
  }
  const requirements = snapshot.demand.filter((cell) => cell.source === 'period-requirement');
  if (requirements.length === 0) {
    findings.push({
      code: 'no_demand',
      tier: 'configuration',
      date: null,
      shiftTypeId: null,
      detail:
        'this period carries no requirement rows, so a build would be asked to staff nothing',
    });
  }
  if (snapshot.periodStatus === 'closed') {
    findings.push({
      code: 'period_closed',
      tier: 'configuration',
      date: null,
      shiftTypeId: null,
      detail: 'a closed period is not built into',
    });
  }

  return findings;
}
