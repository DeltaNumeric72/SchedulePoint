/**
 * **Demand coverage over SPEC-04 §7's own unit** (OPUS-M4-004, repair F-03).
 *
 * ## The defect this replaces
 *
 * `demand_satisfaction_rate` was computed as
 * `min(assignments.length, requiredSlots) / requiredSlots` — a COUNT, compared
 * against a total, with nothing anywhere asking whether an assignment was on a
 * cell that had asked for anybody. A candidate that placed the right NUMBER of
 * people on entirely the wrong dates scored a flawless `1`, and because the
 * `unmet-demand` conflict is raised by reading that same number, the conflict
 * that exists precisely to catch it was suppressed by the same arithmetic.
 * The reviewer's probe-04 falsified it in four lines: same count, every
 * assignment moved to a date carrying no requirement, still `1`.
 *
 * That is the worst shape a metric can have. It is not merely wrong — it is
 * confidently, quietly wrong in the direction of "everything is fine", on a
 * screen a scheduler uses to decide whether a schedule may be approved.
 *
 * ## The unit is the cell, because RK-RULING-01 says it is
 *
 * Coverage counts over **date × shift type** (`RK-RULING-01`), and a cell's fill
 * is capped at *its own* requirement — otherwise two people doubled up on Monday
 * would silently pay for nobody on Tuesday, which is the same averaging-away
 * this module exists to stop.
 *
 * ## Why this lives in the domain and takes plain inputs
 *
 * The independent checker and the metric must agree with each other and remain
 * independent of **the model**, which posts demand in Python as a hard equality
 * (`cpsat_adapter.py`: `sum(cells) == required`). Independence that matters here
 * is independence from the *solver*, not from the metric: one TypeScript
 * statement of the rule, read by both consumers, is a single source of truth on
 * this side of the language boundary — while the Python model remains a wholly
 * separate statement that this one is entitled to disagree with. That
 * disagreement is the entire value of an independent checker (the D-4 lesson:
 * `hardViolations: 0` was once a literal sitting beside the verdict that knew
 * the real count).
 *
 * Inputs are plain arrays rather than the snapshot document, exactly as
 * `quality.ts` does, so `rules/` keeps no dependency on `ports/` and a probe can
 * hand-build a case without assembling a snapshot.
 */

/** One requirement cell. `requiredCount` is what the period ASKED for. */
export interface DemandRequirementCell {
  readonly date: string;
  readonly shiftTypeId: string;
  readonly requiredCount: number;
}

/** One placement in a candidate. Only the cell coordinates matter here. */
export interface DemandPlacement {
  readonly date: string;
  readonly shiftTypeId: string;
}

/** A cell whose requirement the candidate did not meet. */
export interface DemandShortfall {
  readonly date: string;
  readonly shiftTypeId: string;
  readonly requiredCount: number;
  readonly filledCount: number;
}

/**
 * A cell nobody asked for, that the candidate staffed anyway.
 *
 * The model treats this as a violation for a stated reason — "a cell nothing
 * asked for must not be fillable — otherwise the solver could staff a day the
 * scheduler deliberately left empty" — and the checker has to be able to say the
 * same thing independently, or that guarantee rests on the model alone.
 */
export interface DemandOverfill {
  readonly date: string;
  readonly shiftTypeId: string;
  readonly filledCount: number;
}

export interface DemandCoverage {
  /** Σ `requiredCount` over every cell that asked for at least one person. */
  readonly requiredSlots: number;
  /** Σ min(placed, required) per cell — never inflated by a doubled-up cell. */
  readonly filledSlots: number;
  /**
   * SPEC-04 §7 `demand_satisfaction_rate`: filled required slots ÷ required.
   *
   * `null` — not `0` — when the period asked for nothing at all. A rate over an
   * empty denominator is not a bad rate, it is no rate, and `0` would render as
   * a total failure to staff a period that wanted no staffing.
   */
  readonly satisfactionRate: number | null;
  readonly shortfalls: readonly DemandShortfall[];
  readonly overfills: readonly DemandOverfill[];
}

/* U+0000 as the separator, spelled as an ESCAPE. Neither a `YYYY-MM-DD` date nor a
 * uuid can contain it, so no pair of distinct cells can collide on one key — the
 * reason `candidate-validation.ts` keys the same way. The escape is mandatory, not
 * stylistic: a raw NUL in source fails the FAD-45 gate, and it produces a byte-identical
 * string, so there is nothing to trade off. This file shipped with the raw byte and the
 * gate caught it. */
const cellKey = (date: string, shiftTypeId: string): string => `${date}\x00${shiftTypeId}`;

/**
 * Measure a candidate against the requirement cells, per cell.
 *
 * Pure over its arguments: no snapshot, no database, no clock — so the property
 * can be falsified directly rather than through a solve.
 */
export function demandCoverage(
  cells: readonly DemandRequirementCell[],
  placements: readonly DemandPlacement[],
): DemandCoverage {
  /* Aggregated, because two rows naming the same cell are two statements about
   * one cell, not two cells. Taking them as separate cells would let a duplicate
   * row raise the denominator while the placements could only satisfy it once. */
  const required = new Map<string, { date: string; shiftTypeId: string; count: number }>();
  for (const cell of cells) {
    if (!Number.isInteger(cell.requiredCount) || cell.requiredCount <= 0) continue;
    const key = cellKey(cell.date, cell.shiftTypeId);
    const existing = required.get(key);
    if (existing === undefined) {
      required.set(key, {
        date: cell.date,
        shiftTypeId: cell.shiftTypeId,
        count: cell.requiredCount,
      });
    } else {
      existing.count += cell.requiredCount;
    }
  }

  const placed = new Map<string, number>();
  for (const placement of placements) {
    const key = cellKey(placement.date, placement.shiftTypeId);
    placed.set(key, (placed.get(key) ?? 0) + 1);
  }

  let requiredSlots = 0;
  let filledSlots = 0;
  const shortfalls: DemandShortfall[] = [];
  for (const [key, cell] of required) {
    const filled = placed.get(key) ?? 0;
    requiredSlots += cell.count;
    /* Capped at THIS cell's requirement — an over-staffed Monday may not pay for
     * an unstaffed Tuesday. */
    filledSlots += Math.min(filled, cell.count);
    if (filled < cell.count) {
      shortfalls.push({
        date: cell.date,
        shiftTypeId: cell.shiftTypeId,
        requiredCount: cell.count,
        filledCount: filled,
      });
    }
  }

  const overfills: DemandOverfill[] = [];
  for (const [key, filled] of placed) {
    const cell = required.get(key);
    if (cell === undefined) {
      const separator = key.indexOf('\x00');
      overfills.push({
        date: key.slice(0, separator),
        shiftTypeId: key.slice(separator + 1),
        filledCount: filled,
      });
    } else if (filled > cell.count) {
      overfills.push({ date: cell.date, shiftTypeId: cell.shiftTypeId, filledCount: filled });
    }
  }

  return {
    requiredSlots,
    filledSlots,
    satisfactionRate: requiredSlots === 0 ? null : filledSlots / requiredSlots,
    shortfalls,
    overfills,
  };
}
