import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useId, type JSX } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import { SECONDARY_BUTTON_CLASS } from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { MyScheduleLayout } from './MyScheduleLayout.js';
import { fetchDailySheet } from './api.js';
import { describeSpan, entrySummary, longDate, shiftDate } from './model.js';

/**
 * The daily assignment sheet for one date (OPUS-M3-006; CAP-020).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What this is, and what it is emphatically not
 *
 * Doc 07 §1 keeps ten schedule concepts apart, and this page is one of them: a
 * **read of the published master schedule for a date** — who is working today.
 *
 * It is **not** the picklist `daily_assignments` module. That is a turn-taking
 * mechanism with a sequence, a window and a transaction, and it is M9. There is
 * no turn, no pick position, no claim and no offer anywhere on this page, and
 * adding one here would collapse two concepts doc 07 exists to keep separate.
 *
 * ## Everyone on the sheet, which is the point of publishing a rota
 *
 * `docs/fable/08-roles-and-permissions.md` §6 marks "View published schedules"
 * `✓` for Member, Viewer, Scheduler and Group Admin (the full path, because a
 * bare "doc 08" resolves to `docs/architecture/08` under the repo convention).
 * Knowing who is on with you is why the schedule is published; the page carries
 * a colleague's display name, shift and times, and nothing else. Telecom is `—` in that row and receives the surface's permission-denied
 * state rather than an empty sheet — "you may not see this" and "nobody is
 * working" are different facts and the interface never confuses them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function DailySheetPage(): JSX.Element {
  const scope = useGroupScope();
  const navigate = useNavigate();
  const narrow = useNarrowViewport();
  const params = useParams({ strict: false }) as { date?: string };
  const date = params.date ?? '';
  const captionId = useId();

  const sheet = useQuery({
    queryKey: ['daily-sheet', scope.organizationId, scope.groupId, date],
    queryFn: () => fetchDailySheet(scope, date),
    retry: false,
  });

  const entries = sheet.data?.entries ?? [];

  const goto = (days: number): void => {
    void navigate({
      to: '/organizations/$organizationId/groups/$groupId/daily-sheet/$date',
      params: {
        organizationId: scope.organizationId,
        groupId: scope.groupId,
        date: shiftDate(date, days),
      },
    });
  };

  return (
    <MyScheduleLayout
      title="Daily assignment sheet"
      description="Everyone working on one date, from the group's published schedule."
      membershipId={null}
    >
      <section aria-labelledby={captionId} className="flex min-w-0 flex-col gap-sp-3">
        <div className="flex flex-wrap items-center justify-between gap-sp-3">
          <h2 id={captionId} className="text-lg font-semibold text-text">
            {longDate(date)}
          </h2>
          <div className="flex flex-wrap gap-sp-2">
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              data-testid="day-previous"
              onClick={() => goto(-1)}
            >
              Previous day
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              data-testid="day-next"
              onClick={() => goto(1)}
            >
              Next day
            </button>
          </div>
        </div>

        {sheet.data === undefined ? null : (
          <p className="text-sm text-text-muted" data-testid="timezone-note">
            Times are shown in {sheet.data.timezone}.
          </p>
        )}

        <p role="status" aria-live="polite" className="sr-only" data-testid="sheet-status">
          {sheet.isLoading
            ? 'Loading the sheet…'
            : `${String(entries.length)} ${entries.length === 1 ? 'person is' : 'people are'} working on ${longDate(date)}.`}
        </p>

        <SurfaceState
          isLoading={sheet.isLoading}
          error={sheet.error}
          isEmpty={sheet.data !== undefined && entries.length === 0}
          emptyMessage="Nobody is assigned on this date in the published schedule."
          label="the daily sheet"
        >
          {narrow ? (
            <ul className="flex flex-col gap-sp-3" data-testid="sheet-list">
              {entries.map((entry) => (
                <li
                  key={`${entry.assignmentIdentityId}-${entry.membershipId}`}
                  data-entry-summary={entrySummary(date, entry)}
                  className="rounded-panel border border-border bg-surface-raised p-sp-3"
                >
                  <p className="font-semibold text-text">{entry.displayName}</p>
                  <dl className="mt-sp-2 grid grid-cols-[auto,1fr] gap-x-sp-3 gap-y-sp-1 text-sm">
                    <dt className="text-text-muted">Shift</dt>
                    <dd className="text-text">
                      <span className="font-mono font-semibold">{entry.shiftTypeCode}</span>{' '}
                      {entry.shiftTypeName}
                    </dd>
                    <dt className="text-text-muted">When</dt>
                    <dd className="text-text">{describeSpan(entry)}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full border-collapse text-left" data-testid="sheet-table">
                <caption className="sr-only">
                  Everyone assigned on {longDate(date)} in the published schedule.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="border-b border-border p-sp-2 text-sm text-text-muted">
                      Who
                    </th>
                    <th scope="col" className="border-b border-border p-sp-2 text-sm text-text-muted">
                      Shift
                    </th>
                    <th scope="col" className="border-b border-border p-sp-2 text-sm text-text-muted">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={`${entry.assignmentIdentityId}-${entry.membershipId}`}
                      data-entry-summary={entrySummary(date, entry)}
                    >
                      <th scope="row" className="border-b border-border p-sp-2 font-normal text-text">
                        {entry.displayName}
                      </th>
                      <td className="border-b border-border p-sp-2 text-text">
                        <span className="font-mono font-semibold">{entry.shiftTypeCode}</span>{' '}
                        {entry.shiftTypeName}
                      </td>
                      <td className="border-b border-border p-sp-2 text-text">
                        {describeSpan(entry)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SurfaceState>
      </section>
    </MyScheduleLayout>
  );
}
