import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useId, useState, type JSX } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import { SECONDARY_BUTTON_CLASS } from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { MyScheduleLayout } from './MyScheduleLayout.js';
import { ScheduleViews, type ScheduleView } from './ScheduleViews.js';
import { fetchPersonalSchedule } from './api.js';
import { announceSchedule, buildEntryRows, longDate, shiftDate } from './model.js';

/**
 * A staff member's own published schedule (OPUS-M3-006; CAP-020).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What this page can and cannot show
 *
 * It shows the group's CURRENT published version and nothing else. A draft is
 * invisible at the server's query level, a superseded version is invisible for
 * the same reason, and there is no control anywhere on this page that changes a
 * schedule — a published version is immutable (I-18) and this is a read.
 *
 * ## The window is chosen by the browser; every TIME comes from the server
 *
 * The default range is four weeks from the Monday of the current week, and the
 * browser's own date is what picks it. That is the one thing the client is
 * allowed to compute, because it decides which window to ASK about — not what
 * anything means. Every rendered date and time in the response was resolved by
 * the server against the group's zone, and the zone is named on the page so the
 * reader knows what they are looking at.
 *
 * ## I-10, on a read surface
 *
 * One user action, one request. Moving the window issues exactly one GET;
 * switching between the calendar and the table issues **none**, because both
 * render the data the page already holds. Both are budgeted and measured.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The Monday of the week containing the browser's today, as `YYYY-MM-DD`. */
function currentMonday(): string {
  const now = new Date();
  const today = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // `getDay()` is 0 = Sunday; the rota week starts on Monday.
  const offset = (now.getDay() + 6) % 7;
  return shiftDate(today, -offset);
}

/** Four weeks. Long enough to plan around, short enough to read on a phone. */
const WINDOW_DAYS = 28;

export function MySchedulePage(): JSX.Element {
  return (
    <MySchedulePanel />
  );
}

function MySchedulePanel(): JSX.Element {
  const scope = useGroupScope();
  const navigate = useNavigate();
  const narrow = useNarrowViewport();
  const params = useParams({ strict: false }) as { membershipId?: string };
  const membershipId = params.membershipId ?? '';

  const [from, setFrom] = useState(currentMonday);
  const to = shiftDate(from, WINDOW_DAYS - 1);

  /**
   * The rendering the reader gets.
   *
   * The narrow viewport DEFAULTS to the table — a seven-column calendar does not
   * fit in 320px, and pretending otherwise produces horizontal page scroll. It
   * is a default and not a lock: the control switches either way at any width,
   * because "both first-class" has to mean the reader decides.
   */
  const [view, setView] = useState<ScheduleView | null>(null);
  const effectiveView: ScheduleView = view ?? (narrow ? 'table' : 'calendar');

  const captionId = useId();

  const schedule = useQuery({
    queryKey: ['my-schedule', scope.organizationId, scope.groupId, membershipId, from, to],
    queryFn: () => fetchPersonalSchedule(scope, membershipId, { from, to }),
    retry: false,
  });

  const days = schedule.data?.days ?? [];
  const rows = buildEntryRows(days);

  return (
    <MyScheduleLayout
      title="My schedule"
      description="Your shifts in the group's published schedule."
      membershipId={membershipId}
    >
      <section aria-labelledby={captionId} className="flex min-w-0 flex-col gap-sp-3">
        <div className="flex flex-wrap items-center justify-between gap-sp-3">
          <h2 id={captionId} className="text-lg font-semibold text-text">
            {longDate(from)} – {longDate(to)}
          </h2>

          <div className="flex flex-wrap gap-sp-2">
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              data-testid="range-previous"
              onClick={() => setFrom(shiftDate(from, -WINDOW_DAYS))}
            >
              Previous four weeks
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              data-testid="range-next"
              onClick={() => setFrom(shiftDate(from, WINDOW_DAYS))}
            >
              Next four weeks
            </button>
          </div>
        </div>

        {/* Both renderings are offered at every width; the narrow default is a
            starting point, not a restriction. `aria-pressed` rather than a
            radio group, because this is a toggle over the same content. */}
        <div className="flex flex-wrap items-center gap-sp-2">
          <span className="text-sm text-text-muted" id={`${captionId}-view`}>
            View
          </span>
          <div role="group" aria-labelledby={`${captionId}-view`} className="flex gap-sp-2">
            <button
              type="button"
              aria-pressed={effectiveView === 'calendar'}
              className={SECONDARY_BUTTON_CLASS}
              data-testid="view-calendar"
              onClick={() => setView('calendar')}
            >
              Calendar
            </button>
            <button
              type="button"
              aria-pressed={effectiveView === 'table'}
              className={SECONDARY_BUTTON_CLASS}
              data-testid="view-table"
              onClick={() => setView('table')}
            >
              List
            </button>
          </div>
          {schedule.data === undefined ? null : (
            <p className="text-sm text-text-muted" data-testid="timezone-note">
              Times are shown in {schedule.data.timezone}.
            </p>
          )}
        </div>

        {/* SP-HR: the status is programmatic, not only visual. A reader who
            cannot see the calendar is told how many shifts landed in the window
            and how many of them are continuations of the previous day. */}
        <p role="status" aria-live="polite" className="sr-only" data-testid="schedule-status">
          {schedule.isLoading ? 'Loading your schedule…' : announceSchedule(rows, from, to)}
        </p>

        <SurfaceState
          isLoading={schedule.isLoading}
          error={schedule.error}
          isEmpty={false}
          emptyMessage="No shifts in this range."
          label="your schedule"
        >
          {schedule.data === undefined ? null : (
            <ScheduleViews
              days={days}
              view={effectiveView}
              timezone={schedule.data.timezone}
              captionId={captionId}
              onOpenDate={(date) => {
                void navigate({
                  to: '/organizations/$organizationId/groups/$groupId/daily-sheet/$date',
                  params: {
                    organizationId: scope.organizationId,
                    groupId: scope.groupId,
                    date,
                  },
                });
              }}
            />
          )}
        </SurfaceState>
      </section>
    </MyScheduleLayout>
  );
}
