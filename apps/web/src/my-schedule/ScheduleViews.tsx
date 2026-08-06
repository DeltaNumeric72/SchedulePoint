import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';

import type { ScheduleDay, ScheduleEntry } from '@schedulepoint/contracts';

import { useNarrowViewport } from '../components/useNarrowViewport.js';
import {
  WEEKDAY_LABELS,
  buildEntryRows,
  buildWeeks,
  describeSpan,
  entrySummary,
  longDate,
  shortDate,
  spanBadge,
  type CalendarCell,
} from './model.js';

/**
 * The two first-class renderings of a personal published schedule (OPUS-M3-006).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Calendar AND table, and the table is not a fallback
 *
 * The packet requires "accessible calendar view AND tabular alternative (both
 * first-class)". Both are shipped, the user chooses, and exactly one is in the
 * DOM at a time — rendering both and hiding one with CSS would put every shift
 * in the accessibility tree twice, which is the lesson `useNarrowViewport`
 * records from the catalogue and rules surfaces.
 *
 *  - **Calendar** — an ARIA `grid` of Monday-first weeks with roving-tabindex
 *    arrow navigation, for seeing the SHAPE of a month: which weekends are
 *    working, where the nights cluster. Spatial information a list cannot carry.
 *  - **Table** — a real `<table>` with `<th scope>`, one row per entry, in date
 *    order. Better for assistive technology and better for "what am I doing next
 *    Tuesday", which is why it is offered as a peer rather than as a degraded
 *    mode. **Below 640px it becomes a LIST of the same entries**, because a
 *    five-column table at 320px produces horizontal page scroll (SC 1.4.10) —
 *    the measured reason the authoring, rules and catalogue surfaces all made
 *    the same move.
 *
 * ## What makes them equal, mechanically
 *
 * Neither walks the API response; both walk `model.ts`, and both emit the same
 * `data-entry-summary` per entry. `apps/web/e2e/my-schedule.spec.ts` compares the
 * two sets, so a divergence is a failing test rather than a review observation.
 *
 * ## An overnight shift reads as ONE shift, twice
 *
 * It appears on both days because it occupies both, and the two days say
 * different things — "22:00 until 06:00 the next day" and "continues from 22:00
 * on …, until 06:00". Repeating an identical "22:00–06:00" on both would tell
 * the reader they work sixteen hours.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type ScheduleView = 'calendar' | 'table';

export interface ScheduleViewsProps {
  readonly days: readonly ScheduleDay[];
  readonly view: ScheduleView;
  readonly timezone: string;
  /** Opening a day is the surface's one navigation, and it is keyboard-reachable. */
  readonly onOpenDate: (date: string) => void;
  readonly captionId: string;
}

export function ScheduleViews(props: ScheduleViewsProps): JSX.Element {
  return props.view === 'table' ? <ScheduleTable {...props} /> : <ScheduleCalendar {...props} />;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The calendar
 * ──────────────────────────────────────────────────────────────────────────── */

function ScheduleCalendar({
  days,
  onOpenDate,
  captionId,
}: ScheduleViewsProps): JSX.Element {
  const weeks = buildWeeks(days);
  const flat = weeks.flat();
  const firstDated = flat.findIndex((cell) => cell.date !== null);
  const [focused, setFocused] = useState(Math.max(0, firstDated));
  const [pendingFocus, setPendingFocus] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // The roving index must stay on a real day when the range changes underneath
  // it — otherwise "previous four weeks" can leave the tab order pointing at a
  // blank alignment cell, and the first Tab into the calendar goes nowhere.
  useEffect(() => {
    if (flat[focused]?.date === undefined || flat[focused]?.date === null) {
      setFocused(Math.max(0, flat.findIndex((cell) => cell.date !== null)));
    }
  }, [flat, focused]);

  useEffect(() => {
    if (!pendingFocus) return;
    const node = container.current?.querySelector<HTMLElement>(
      `[data-cell-index="${String(focused)}"]`,
    );
    node?.focus();
    setPendingFocus(false);
  }, [pendingFocus, focused]);

  /**
   * Move the roving focus by `delta`, skipping the alignment blanks.
   *
   * Blanks are real `gridcell`s — every week has seven columns, which is what
   * keeps the weekday headers meaning what they say — but they are not days, so
   * arrow navigation steps over them rather than parking on one.
   */
  const move = useCallback(
    (delta: number) => {
      let next = focused + delta;
      while (next >= 0 && next < flat.length && flat[next]?.date === null) next += delta;
      if (next < 0 || next >= flat.length || flat[next]?.date == null) return;
      setFocused(next);
      setPendingFocus(true);
    },
    [flat, focused],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, cell: CalendarCell): void => {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const delta = moves[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      move(delta);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const index =
        event.key === 'Home'
          ? flat.findIndex((candidate) => candidate.date !== null)
          : flat.length - 1 - [...flat].reverse().findIndex((candidate) => candidate.date !== null);
      setFocused(Math.max(0, index));
      setPendingFocus(true);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && cell.date !== null) {
      event.preventDefault();
      onOpenDate(cell.date);
    }
  };

  return (
    <div
      ref={container}
      role="grid"
      aria-labelledby={captionId}
      aria-rowcount={weeks.length + 1}
      aria-colcount={7}
      className="min-w-0 overflow-x-auto"
      data-testid="schedule-calendar"
    >
      <div role="rowgroup">
        <div role="row" aria-rowindex={1} className="grid grid-cols-7 gap-px">
          {WEEKDAY_LABELS.map((label, column) => (
            <div
              key={label}
              role="columnheader"
              aria-colindex={column + 1}
              className="bg-surface-raised px-sp-2 py-sp-2 text-sm font-semibold text-text-muted"
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      <div role="rowgroup">
        {weeks.map((week, row) => (
          <div
            key={week.map((cell) => cell.date ?? `blank-${String(row)}`).join('|')}
            role="row"
            aria-rowindex={row + 2}
            className="grid grid-cols-7 gap-px"
          >
            {week.map((cell, column) => {
              const index = row * 7 + column;
              const isFocusTarget = index === focused;
              if (cell.date === null) {
                return (
                  <div
                    key={`blank-${String(index)}`}
                    role="gridcell"
                    aria-colindex={column + 1}
                    aria-label="Outside the selected range"
                    className="min-h-[4.5rem] bg-surface-raised/40"
                  />
                );
              }
              return (
                <div
                  key={cell.date}
                  role="gridcell"
                  aria-colindex={column + 1}
                  aria-label={dayLabel(cell)}
                  data-cell-index={index}
                  data-testid="calendar-day"
                  data-date={cell.date}
                  tabIndex={isFocusTarget ? 0 : -1}
                  onKeyDown={(event) => onKeyDown(event, cell)}
                  onFocus={() => setFocused(index)}
                  className="flex min-h-[4.5rem] min-w-0 flex-col gap-sp-1 border border-border bg-surface-raised p-sp-2 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-accent"
                >
                  <span className="text-sm font-semibold text-text">{shortDate(cell.date)}</span>
                  {cell.entries.map((entry) => (
                    <span
                      key={`${entry.assignmentIdentityId}-${cell.date ?? ''}`}
                      data-entry-summary={entrySummary(cell.date ?? '', entry)}
                      className="rounded-control bg-accent/10 px-sp-1 py-[2px] text-sm text-text"
                    >
                      <span className="font-mono font-semibold">{entry.shiftTypeCode}</span>{' '}
                      {entry.isContinuation ? `→ ${entry.endTime}` : `${entry.startTime}`}
                      {spanBadge(entry) === null ? null : (
                        <span className="ml-sp-1 text-text-muted">({spanBadge(entry) ?? ''})</span>
                      )}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The whole cell as one sentence, for the accessibility tree.
 *
 * A gridcell whose accessible name is only "4 Jun" tells a screen-reader user
 * the date and nothing about the shift, so they would have to enter the cell to
 * discover whether they are working. The label carries the answer.
 */
function dayLabel(cell: CalendarCell): string {
  const date = cell.date ?? '';
  if (cell.entries.length === 0) return `${longDate(date)}: no shifts`;
  return `${longDate(date)}: ${cell.entries
    .map((entry) => `${entry.shiftTypeName}, ${describeSpan(entry)}`)
    .join('; ')}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The tabular alternative
 * ──────────────────────────────────────────────────────────────────────────── */

function ScheduleTable({ days, timezone, captionId }: ScheduleViewsProps): JSX.Element {
  const rows = buildEntryRows(days);
  const narrow = useNarrowViewport();

  if (rows.length === 0) {
    return (
      <p className="rounded-panel border border-border bg-surface-raised p-sp-4 text-text-muted">
        No shifts in this range.
      </p>
    );
  }

  if (narrow) {
    return (
      <ul className="flex flex-col gap-sp-3" data-testid="schedule-list">
        {rows.map(({ date, entry }) => (
          <li
            key={`${entry.assignmentIdentityId}-${date}`}
            data-entry-summary={entrySummary(date, entry)}
            className="rounded-panel border border-border bg-surface-raised p-sp-3"
          >
            <p className="font-semibold text-text">{longDate(date)}</p>
            <dl className="mt-sp-2 grid grid-cols-[auto,1fr] gap-x-sp-3 gap-y-sp-1 text-sm">
              <dt className="text-text-muted">Shift</dt>
              <dd className="text-text">
                <span className="font-mono font-semibold">{entry.shiftTypeCode}</span>{' '}
                {entry.shiftTypeName}
              </dd>
              <dt className="text-text-muted">When</dt>
              <dd className="text-text">{describeSpan(entry)}</dd>
              <dt className="text-text-muted">Time zone</dt>
              <dd className="text-text">{timezone}</dd>
            </dl>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse text-left" data-testid="schedule-table">
        <caption className="sr-only" id={`${captionId}-table`}>
          Shifts in the selected range, in date order. Times are shown in {timezone}.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="border-b border-border p-sp-2 text-sm text-text-muted">
              Date
            </th>
            <th scope="col" className="border-b border-border p-sp-2 text-sm text-text-muted">
              Shift
            </th>
            <th scope="col" className="border-b border-border p-sp-2 text-sm text-text-muted">
              When
            </th>
            <th scope="col" className="border-b border-border p-sp-2 text-sm text-text-muted">
              Notes
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ date, entry }) => (
            <tr
              key={`${entry.assignmentIdentityId}-${date}`}
              data-entry-summary={entrySummary(date, entry)}
            >
              <th scope="row" className="border-b border-border p-sp-2 font-normal text-text">
                {longDate(date)}
              </th>
              <td className="border-b border-border p-sp-2 text-text">
                <span className="font-mono font-semibold">{entry.shiftTypeCode}</span>{' '}
                {entry.shiftTypeName}
              </td>
              <td className="border-b border-border p-sp-2 text-text">{describeSpan(entry)}</td>
              <td className="border-b border-border p-sp-2 text-text-muted">
                {noteFor(entry)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The one-word note a row carries. Never "—": an empty cell says nothing louder. */
function noteFor(entry: ScheduleEntry): string {
  const notes: string[] = [];
  if (entry.isOnCall) notes.push('On call');
  if (entry.isContinuation) notes.push('Continued from the previous day');
  else if (entry.continuesToNextDay) notes.push('Runs past midnight');
  return notes.join(' · ');
}
