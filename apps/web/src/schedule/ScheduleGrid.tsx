import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';

import type { GridShiftType } from '@schedulepoint/contracts';

import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { describeCell, type CellView, type RowView } from './grid-model.js';

/**
 * The two first-class renderings of one schedule version (OPUS-M3-004).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Two renderings, and the second is not a degraded mode
 *
 * SP-E §5 requires "320px reflow with list alternatives for grids", and §3
 * requires that "virtualization must not break AT row navigation". Both are
 * satisfied by shipping two real presentations of `buildRows`, chosen by the
 * user:
 *
 *  - **Grid** — an ARIA `grid` with roving-tabindex arrow navigation and row
 *    windowing, for scanning a month at a time with a mouse or keyboard.
 *  - **Table** — a real `<table>` with `<th scope>` on both axes, one row per
 *    (date × shift type), NOT virtualized, so a screen reader gets native row
 *    and column announcement over the complete data. **Below 640px it becomes a
 *    LIST of the same cells**, because a six-column table at 320px is a table
 *    nobody can read: the first version of this file kept the table at every
 *    width and the 320px assertion measured 142px of page overflow (SC 1.4.10).
 *    Same data, same `data-cell-summary`, same actions — the rules and
 *    catalogue surfaces made the same move for the same measured reason.
 *
 * The table is the better rendering for assistive technology, which is exactly
 * why it is offered as a peer rather than as a fallback: the user picks, the
 * narrow viewport defaults to the table, and neither is hidden with CSS. Exactly
 * one is in the DOM at a time, because rendering both and hiding one would put
 * every cell in the accessibility tree twice (`useNarrowViewport`'s docblock
 * records that lesson from the catalogue and the rules surfaces).
 *
 * ## What makes them equal, mechanically
 *
 * Neither walks the API response. Both consume `buildRows`, and both emit the
 * same `data-cell-summary` per cell. `apps/web/e2e/schedule.spec.ts` compares the
 * two sets, so a divergence is a failing test rather than a review observation.
 *
 * ## The windowing, and why the ARIA stays valid
 *
 * Only the visible band of rows is in the DOM. `aria-rowcount` on the grid
 * declares the TRUE total and every rendered row carries its true
 * `aria-rowindex`, which is the ARIA contract for exactly this case — an AT user
 * is told "row 34 of 62" rather than "row 4 of 8".
 *
 * The scroll extent comes from padding on the row group rather than from
 * absolutely positioned rows or spacer elements, and that is a deliberate
 * structural choice: `role="grid"` must own `role="rowgroup"`, which must own
 * `role="row"`. A spacer element between them would break
 * `aria-required-children`, which axe checks and which is exactly the kind of
 * "the virtualization broke the semantics" defect the brief warns about.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type GridView = 'grid' | 'table';

const ROW_HEIGHT = 56;
const VIEWPORT_HEIGHT = 448;
/** Rows rendered beyond the visible band, so a fast scroll does not flash empty. */
const OVERSCAN = 4;

export interface ScheduleGridProps {
  readonly rows: readonly RowView[];
  readonly shiftTypes: readonly GridShiftType[];
  readonly view: GridView;
  readonly onOpenCell: (cell: CellView) => void;
  /** Rendered in the cell so provenance is visible without opening the editor. */
  readonly timezone: string;
}

export function ScheduleGridView(props: ScheduleGridProps): JSX.Element {
  return props.view === 'table' ? <TabularAlternative {...props} /> : <VirtualizedGrid {...props} />;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The virtualized ARIA grid
 * ──────────────────────────────────────────────────────────────────────────── */

function VirtualizedGrid({
  rows,
  shiftTypes,
  onOpenCell,
}: ScheduleGridProps): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  /** Roving tabindex: exactly one cell is in the tab order at a time. */
  const [focus, setFocus] = useState<{ row: number; column: number }>({ row: 0, column: 0 });
  const [pendingFocus, setPendingFocus] = useState(false);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, first + Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2);
  const windowed = rows.slice(first, last);

  // Moving the roving focus must bring the target into the window before the
  // browser can focus it — a cell that is not rendered cannot receive focus, and
  // arrow-key navigation that silently stopped at the window edge would be the
  // "virtualization broke AT navigation" defect in its purest form.
  useEffect(() => {
    if (!pendingFocus) return;
    const node = scroller.current?.querySelector<HTMLElement>(
      `[data-cell-position="${String(focus.row)}-${String(focus.column)}"]`,
    );
    if (node !== null && node !== undefined) {
      node.focus();
      setPendingFocus(false);
    }
    // The dependencies are the WINDOW BOUNDS, not the rendered count. Keying on
    // `windowed.length` was a defect the red-case battery exposed: scrolling by
    // a whole page changes `first` while the length stays constant, so the
    // effect did not re-run, the target row had not been rendered when it last
    // did, and focus was silently dropped at the window boundary — exactly the
    // "virtualization broke AT navigation" failure the brief warns about. It
    // passed nine runs and failed the tenth.
  }, [pendingFocus, focus, first, last]);

  const moveFocus = useCallback(
    (row: number, column: number): void => {
      const clampedRow = Math.min(Math.max(row, 0), rows.length - 1);
      const clampedColumn = Math.min(Math.max(column, 0), shiftTypes.length - 1);
      setFocus({ row: clampedRow, column: clampedColumn });

      const top = clampedRow * ROW_HEIGHT;
      const element = scroller.current;
      if (element !== null) {
        const height = element.clientHeight;
        const current = element.scrollTop;
        const next =
          top < current ? top : top + ROW_HEIGHT > current + height ? top + ROW_HEIGHT - height : current;
        if (next !== current) {
          element.scrollTop = next;
          // The STATE is set too, not only the DOM property. The window is
          // derived from state, and the browser's scroll event is asynchronous
          // — so without this the render that follows a key press still uses
          // the old bounds and the target cell is not in the DOM to receive
          // focus.
          setScrollTop(next);
        }
      }
      setPendingFocus(true);
    },
    [rows.length, shiftTypes.length],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, cell: CellView): void => {
    const keys: Record<string, [number, number]> = {
      ArrowDown: [focus.row + 1, focus.column],
      ArrowUp: [focus.row - 1, focus.column],
      ArrowRight: [focus.row, focus.column + 1],
      ArrowLeft: [focus.row, focus.column - 1],
      Home: [focus.row, 0],
      End: [focus.row, shiftTypes.length - 1],
      PageDown: [focus.row + 7, focus.column],
      PageUp: [focus.row - 7, focus.column],
    };
    const target = keys[event.key];
    if (target !== undefined) {
      event.preventDefault();
      moveFocus(target[0], target[1]);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenCell(cell);
    }
  };

  return (
    <div
      aria-colcount={shiftTypes.length + 1}
      aria-labelledby="schedule-grid-heading"
      aria-rowcount={rows.length + 1}
      className="max-h-[28rem] overflow-auto rounded-panel border border-border bg-surface"
      data-testid="schedule-grid"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={scroller}
      role="grid"
    >
      <div className="sticky top-0 z-10 bg-surface-raised" role="rowgroup">
        <div className="flex border-b border-border" role="row" aria-rowindex={1}>
          <div
            aria-colindex={1}
            className="w-32 shrink-0 p-sp-2 font-semibold text-text"
            role="columnheader"
          >
            Date
          </div>
          {shiftTypes.map((shiftType, index) => (
            <div
              aria-colindex={index + 2}
              className="w-24 shrink-0 p-sp-2 font-semibold text-text"
              key={shiftType.id}
              role="columnheader"
              title={shiftType.name}
            >
              {shiftType.code}
            </div>
          ))}
        </div>
      </div>

      {/* The scroll extent is PADDING on the row group, so the group's only
          children are rows and `aria-required-children` stays satisfied. */}
      <div
        role="rowgroup"
        style={{
          paddingTop: `${String(first * ROW_HEIGHT)}px`,
          paddingBottom: `${String((rows.length - last) * ROW_HEIGHT)}px`,
        }}
      >
        {windowed.map((row, offset) => {
          const rowIndex = first + offset;
          return (
            <div
              aria-rowindex={rowIndex + 2}
              className="flex border-b border-border"
              key={row.date}
              role="row"
              style={{ height: `${String(ROW_HEIGHT)}px` }}
            >
              <div
                aria-colindex={1}
                className="w-32 shrink-0 p-sp-2 font-medium text-text"
                role="rowheader"
              >
                {row.date}
              </div>
              {row.cells.map((cell, column) => (
                <div
                  aria-colindex={column + 2}
                  aria-label={describeCell(cell)}
                  className="w-24 shrink-0 border-l border-border p-sp-2 text-sm text-text focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-accent"
                  data-cell-position={`${String(rowIndex)}-${String(column)}`}
                  data-cell-summary={cell.summary}
                  data-testid={`grid-cell-${cell.date}-${cell.shiftTypeCode}`}
                  key={cell.shiftTypeId}
                  onClick={() => {
                    setFocus({ row: rowIndex, column });
                    onOpenCell(cell);
                  }}
                  onKeyDown={(event) => onKeyDown(event, cell)}
                  role="gridcell"
                  tabIndex={focus.row === rowIndex && focus.column === column ? 0 : -1}
                >
                  <CellBody cell={cell} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What a cell shows.
 *
 * Counts as text and markers as short words — never colour alone (SPEC-14,
 * SP-E §5). The `aria-label` on the cell carries the same facts as a sentence,
 * so an AT user is not asked to interpret "2/3 · under".
 */
function CellBody({ cell }: { cell: CellView }): JSX.Element {
  return (
    <>
      <span className={cell.isIncomplete ? 'font-semibold text-danger' : 'text-text'}>
        {String(cell.filledCount)}/{String(cell.requiredCount)}
      </span>
      <span aria-hidden="true" className="ml-sp-1 text-xs text-text-muted">
        {cell.isIncomplete ? 'under' : ''}
        {cell.assignments.some((assignment) => assignment.isPinned) ? ' pin' : ''}
        {cell.assignments.some((assignment) => assignment.overrideReasonGiven) ? ' ovr' : ''}
      </span>
    </>
  );
}

/**
 * The cell's notes as WORDS, so they survive greyscale, forced colours and a
 * screen reader alike (SPEC-14: never colour alone). One function, so the table
 * and the list say exactly the same thing.
 */
function noteFor(cell: CellView): string {
  const notes: string[] = [];
  if (cell.isIncomplete) notes.push('Requirement not met.');
  if (cell.isOverfilled) notes.push('More assigned than required.');
  if (cell.assignments.some((assignment) => assignment.isPinned)) notes.push('Pinned.');
  if (cell.assignments.some((assignment) => assignment.overrideReasonGiven)) notes.push('Override.');
  if (cell.assignments.some((assignment) => assignment.creditId !== null)) notes.push('Credit moved.');

  /* Location, as WORDS like every other note here (OPUS-M4-000B). The named
     places are listed rather than counted, because "at Ward B" is the thing a
     scheduler scanning a month is looking for and "1 location" is not.
     `Set` de-duplicates the ordinary case where every assignment in the cell is
     at the same place. */
  const places = [
    ...new Set(
      cell.assignments
        .map((assignment) => assignment.locationName)
        .filter((name): name is string => name !== null),
    ),
  ].sort();
  if (places.length > 0) notes.push(`At ${places.join(', ')}.`);

  /* Archiving a location RETAINS existing references (only NEW ones are
     refused), so a live cell can point at a decommissioned place. Saying so is
     the "rendered with the archived marker" half of that rule — silence would
     leave a scheduler assigning around a site that no longer exists. */
  if (cell.assignments.some((assignment) => assignment.locationArchived)) {
    notes.push('Location archived.');
  }

  return notes.length === 0 ? 'None' : notes.join(' ');
}

/* ────────────────────────────────────────────────────────────────────────────
 * The tabular alternative — a peer, not a fallback
 * ──────────────────────────────────────────────────────────────────────────── */

function TabularAlternative({ rows, onOpenCell }: ScheduleGridProps): JSX.Element {
  const narrow = useNarrowViewport();
  const cells = rows.flatMap((row) => row.cells);

  if (narrow) {
    /* The list form. Chosen in JavaScript rather than hidden in CSS: rendering
       both and hiding one would put every cell in the accessibility tree twice
       (`useNarrowViewport`'s docblock records that lesson). */
    return (
      <ul className="flex flex-col gap-sp-3" data-testid="schedule-list">
        {cells.map((cell) => (
          <li
            className="rounded-panel border border-border bg-surface-raised p-sp-3"
            data-cell-summary={cell.summary}
            data-testid={`table-cell-${cell.date}-${cell.shiftTypeCode}`}
            key={`${cell.date}|${cell.shiftTypeId}`}
          >
            <h3 className="font-semibold text-text">
              {cell.shiftTypeCode} on {cell.date}
            </h3>
            <dl className="mt-sp-2 flex flex-col gap-sp-1 text-sm">
              <div className="flex gap-sp-2">
                <dt className="text-text-muted">Assigned</dt>
                <dd className="text-text">
                  {String(cell.filledCount)} of {String(cell.requiredCount)} required
                </dd>
              </div>
              <div className="flex gap-sp-2">
                <dt className="text-text-muted">Notes</dt>
                <dd className="text-text">{noteFor(cell)}</dd>
              </div>
            </dl>
            <p className="mt-sp-3">
              <button
                className="min-h-target min-w-target rounded-control border border-border bg-surface px-sp-3 py-sp-2 text-text"
                onClick={() => onOpenCell(cell)}
                type="button"
              >
                Edit
                <span className="sr-only">
                  {' '}
                  {cell.shiftTypeCode} on {cell.date}
                </span>
              </button>
            </p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse text-left" data-testid="schedule-table">
        <caption className="sr-only">
          Every date and shift type in this version, with how many people are assigned against how
          many are required.
        </caption>
        <thead>
          <tr>
            <th className="border-b border-border p-sp-2" scope="col">
              Date
            </th>
            <th className="border-b border-border p-sp-2" scope="col">
              Shift type
            </th>
            <th className="border-b border-border p-sp-2" scope="col">
              Assigned
            </th>
            <th className="border-b border-border p-sp-2" scope="col">
              Required
            </th>
            <th className="border-b border-border p-sp-2" scope="col">
              Notes
            </th>
            <th className="border-b border-border p-sp-2" scope="col">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((row) =>
            row.cells.map((cell) => (
              <tr
                data-cell-summary={cell.summary}
                data-testid={`table-cell-${cell.date}-${cell.shiftTypeCode}`}
                key={`${cell.date}|${cell.shiftTypeId}`}
              >
                <th className="border-b border-border p-sp-2 font-normal" scope="row">
                  {cell.date}
                </th>
                <td className="border-b border-border p-sp-2">{cell.shiftTypeCode}</td>
                <td className="border-b border-border p-sp-2">{String(cell.filledCount)}</td>
                <td className="border-b border-border p-sp-2">{String(cell.requiredCount)}</td>
                <td className="border-b border-border p-sp-2">{noteFor(cell)}</td>
                <td className="border-b border-border p-sp-2">
                  <button
                    className="min-h-target min-w-target rounded-control border border-border bg-surface px-sp-3 py-sp-2 text-text"
                    onClick={() => onOpenCell(cell)}
                    type="button"
                  >
                    Edit
                    <span className="sr-only">
                      {' '}
                      {cell.shiftTypeCode} on {cell.date}
                    </span>
                  </button>
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
