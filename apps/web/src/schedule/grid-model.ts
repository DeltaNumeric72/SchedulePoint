import type { GridAssignment, GridCell, ScheduleGrid } from '@schedulepoint/contracts';

/**
 * The one derivation both renderings consume (OPUS-M3-004).
 *
 * ## Why this file exists at all
 *
 * The packet requires "a virtualized scheduling grid PLUS a first-class
 * accessible tabular/list alternative rendering the same data (equality asserted
 * in e2e)". Two renderers that each walked the raw response would be two chances
 * to filter, sort or label differently — and the e2e equality assertion would
 * then be testing that nobody had made that mistake yet, rather than that the
 * mistake is impossible.
 *
 * So the shape is derived ONCE, here, as a pure function. The grid and the table
 * are two presentations of the same array. The e2e assertion compares the
 * rendered `data-cell-summary` of each, and this function is why they can agree.
 *
 * ## `summary` is the equality key
 *
 * A single string per cell carrying everything a reader is told: the date, the
 * shift type code, the filled/required counts, and each marker. It is rendered
 * into both DOMs as `data-cell-summary`, so the equality proof compares what was
 * actually displayed rather than what the component was handed.
 */

export interface CellView {
  readonly date: string;
  readonly shiftTypeId: string;
  readonly shiftTypeCode: string;
  readonly requiredCount: number;
  readonly filledCount: number;
  /** Requirement not met. NEVER carried by colour alone (SPEC-14). */
  readonly isIncomplete: boolean;
  readonly isOverfilled: boolean;
  readonly assignments: readonly GridAssignment[];
  readonly revision: string;
  /** The string both renderings emit, and the e2e compares. */
  readonly summary: string;
}

export interface RowView {
  readonly date: string;
  readonly cells: readonly CellView[];
}

function markersOf(cell: {
  isIncomplete: boolean;
  isOverfilled: boolean;
  assignments: readonly GridAssignment[];
}): string[] {
  const markers: string[] = [];
  if (cell.isIncomplete) markers.push('under');
  if (cell.isOverfilled) markers.push('over');
  if (cell.assignments.some((assignment) => assignment.isPinned)) markers.push('pinned');
  if (cell.assignments.some((assignment) => assignment.overrideReasonGiven)) {
    markers.push('override');
  }
  if (cell.assignments.some((assignment) => assignment.creditId !== null)) markers.push('credit');
  if (cell.assignments.some((assignment) => assignment.origin === 'clone')) markers.push('cloned');
  return markers;
}

export function buildRows(grid: ScheduleGrid): RowView[] {
  const byKey = new Map<string, GridCell>();
  for (const cell of grid.cells) byKey.set(`${cell.date}|${cell.shiftTypeId}`, cell);

  return grid.dates.map((date) => ({
    date,
    cells: grid.shiftTypes.map((shiftType) => {
      const cell = byKey.get(`${date}|${shiftType.id}`);
      const assignments = cell?.assignments ?? [];
      const requiredCount = cell?.requiredCount ?? 0;
      const filledCount = assignments.length;
      const isIncomplete = filledCount < requiredCount;
      const isOverfilled = requiredCount > 0 && filledCount > requiredCount;
      const markers = markersOf({ isIncomplete, isOverfilled, assignments });

      return {
        date,
        shiftTypeId: shiftType.id,
        shiftTypeCode: shiftType.code,
        requiredCount,
        filledCount,
        isIncomplete,
        isOverfilled,
        assignments,
        // An empty cell still carries the version's empty-cell revision, so the
        // very first assignment into it has a compare-and-set token like every
        // other edit.
        revision: cell?.revision ?? grid.emptyCellRevision,
        summary: `${date}|${shiftType.code}|${String(filledCount)}/${String(requiredCount)}${
          markers.length === 0 ? '' : `|${markers.join(',')}`
        }`,
      };
    }),
  }));
}

/** How a cell is described to a screen reader, in words rather than by position. */
export function describeCell(cell: CellView): string {
  const base = `${cell.shiftTypeCode} on ${cell.date}, ${String(cell.filledCount)} of ${String(
    cell.requiredCount,
  )} assigned`;
  const notes: string[] = [];
  if (cell.isIncomplete) notes.push('requirement not met');
  if (cell.isOverfilled) notes.push('more assigned than required');
  if (cell.assignments.some((assignment) => assignment.isPinned)) notes.push('contains a pin');
  if (cell.assignments.some((assignment) => assignment.overrideReasonGiven)) {
    notes.push('contains an override');
  }
  // PARITY with the table's Notes column. The grid used to omit these two, so a
  // screen-reader user on the grid was told strictly less than a sighted user on
  // the table about the same cell — the accessible rendering must not be the
  // poorer one.
  if (cell.assignments.some((assignment) => assignment.creditId !== null)) {
    notes.push('credit moved');
  }
  if (cell.assignments.some((assignment) => assignment.origin === 'clone')) {
    notes.push('copied from an earlier version');
  }
  return notes.length === 0 ? base : `${base}, ${notes.join(', ')}`;
}
