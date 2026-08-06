import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { JSX } from 'react';
import type { PublishedSchedule } from '@schedulepoint/contracts';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import { SECONDARY_BUTTON_CLASS } from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { fetchPublicationRecords, fetchPublishedSchedule } from './api.js';
import { timeIn } from './DifferenceView.js';
import { PublicationLayout, publicationSections } from './PublicationLayout.js';

/**
 * The published schedule, and what the publication transaction recorded
 * (OPUS-M3-005).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## This is the scheduler's read of what is LIVE
 *
 * One period, its current published version, rendered read-only. It is
 * deliberately not the authoring grid: the grid's whole shape is built around
 * cells you can open, and a read-only grid is a grid that teaches the wrong
 * thing. This is a list of what people are working to, with **no editing
 * affordance of any kind** — there is no control on this page that writes
 * anything.
 *
 * The staff-facing personal view is a different surface with different scoping
 * rules and is OPUS-M3-006's; nothing here answers it.
 *
 * ## The records table is publication records, NOT the audit chain
 *
 * The packet asks for publication audit display "where authorized", and adds:
 * "if no audit read API exists, that is an escalation, not an in-packet
 * audit-module edit". **There is no audit read API** — `apps/api/src/audit/`
 * exposes a recorder, a chain verifier and a checkpoint writer, and no route in
 * the application reads `audit_events`. That gap is escalated in the return
 * report and is not worked around here.
 *
 * What this table shows instead is `publication_records`: the publication
 * module's own append-only account of what it did, on which no UPDATE or DELETE
 * grant exists (D-15d). It answers "who published this version, when, and how
 * many people it affected" truthfully, and the heading says exactly what it is
 * so that nobody reads it as the audit trail.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function PublishedSchedulePage(): JSX.Element {
  const scope = useGroupScope();
  const params = useParams({ strict: false }) as { periodId?: string };
  const periodId = params.periodId ?? '';

  const published = useQuery({
    queryKey: ['published-schedule', scope.organizationId, scope.groupId, periodId],
    queryFn: () => fetchPublishedSchedule(scope, periodId),
    retry: false,
  });

  const records = useQuery({
    queryKey: ['publication-records', scope.organizationId, scope.groupId, periodId],
    queryFn: () => fetchPublicationRecords(scope, periodId),
    retry: false,
  });

  return (
    <PublicationLayout
      description="What staff are working to right now for this period, exactly as the current published version says."
      sections={publicationSections(scope, periodId, 'published')}
      title="Published schedule"
    >
      <SurfaceState
        isLoading={published.isPending}
        error={published.error}
        isEmpty={published.data !== undefined && published.data.version === null}
        emptyMessage="Nothing has been published for this period yet. Staff cannot see a schedule for it until a version is published."
        label="the published schedule"
      >
        {published.data === undefined || published.data.version === null ? null : (
          <PublishedPanel schedule={published.data} />
        )}
      </SurfaceState>

      <section aria-labelledby="records-heading" className="flex min-w-0 flex-col gap-sp-2">
        <h2 className="text-lg font-semibold text-text" id="records-heading">
          Publication records
        </h2>
        <p className="text-sm text-text-muted" data-testid="records-scope-note">
          These are the publication module&apos;s own records of each publication of this period —
          not the audit chain, which has no read surface in the application yet.
        </p>
        <SurfaceState
          isLoading={records.isPending}
          error={records.error}
          isEmpty={records.data !== undefined && records.data.records.length === 0}
          emptyMessage="This period has never been published, so there are no publication records."
          label="the publication records"
        >
          {records.data === undefined ? null : (
            <div className="min-w-0 overflow-x-auto" tabIndex={0}>
              <table className="w-full border-collapse text-left" data-testid="records-table">
                <caption className="sr-only">
                  Every recorded publication of this period, newest first
                </caption>
                <thead>
                  <tr>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Version
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Recorded
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      By
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      People affected
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Outcome
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {records.data.records.map((record) => (
                    <tr data-testid={`record-${record.id}`} key={record.id}>
                      <th className="border-b border-border p-sp-2 font-medium text-text" scope="row">
                        {record.versionNumber === null
                          ? 'Unnumbered'
                          : `Version ${String(record.versionNumber)}`}
                      </th>
                      <td className="border-b border-border p-sp-2 text-text">{record.recordedAt}</td>
                      <td className="border-b border-border p-sp-2 text-text">
                        {record.actorDisplayName ?? 'A member no longer listed'}
                      </td>
                      <td className="border-b border-border p-sp-2 text-text">
                        {record.affectedCount ?? 'not recorded'}
                      </td>
                      <td className="border-b border-border p-sp-2 text-text">{record.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SurfaceState>
      </section>
    </PublicationLayout>
  );
}

function PublishedPanel({ schedule }: { schedule: PublishedSchedule }): JSX.Element {
  const scope = useGroupScope();
  const narrow = useNarrowViewport();
  const version = schedule.version;
  if (version === null) return <></>;

  const codeById = new Map(schedule.shiftTypes.map((shiftType) => [shiftType.id, shiftType.code]));

  return (
    <div className="flex min-w-0 flex-col gap-sp-4">
      <section aria-labelledby="published-summary-heading" className="flex flex-col gap-sp-2">
        <h2 className="text-lg font-semibold text-text" id="published-summary-heading">
          {schedule.period.name}
        </h2>
        <p className="text-text-muted" data-testid="published-summary">
          {schedule.period.startDate} to {schedule.period.endDate} · times shown in{' '}
          {schedule.timezone} · version {String(version.versionNumber ?? 0)}, published{' '}
          {version.publishedAt ?? 'at an unrecorded time'} by{' '}
          {version.publishedByDisplayName ?? 'a member no longer listed'}
        </p>
        <p className="text-text" data-testid="published-readonly">
          This version is published and can never be edited. To change it, clone it into a new draft
          from the version history and publish forward.
        </p>
        <p>
          <a
            className={SECONDARY_BUTTON_CLASS}
            data-affordance="read"
            data-testid="published-compare"
            href={`/organizations/${scope.organizationId}/groups/${scope.groupId}/publication/versions/${version.id}/comparison`}
          >
            Compare with the version it replaced
          </a>
        </p>
      </section>

      <section aria-labelledby="published-assignments-heading" className="flex min-w-0 flex-col gap-sp-2">
        <h2 className="text-lg font-semibold text-text" id="published-assignments-heading">
          Assignments
        </h2>
        {schedule.assignments.length === 0 ? (
          <p className="text-text-muted" data-testid="published-assignments-empty">
            This published version holds no assignments.
          </p>
        ) : narrow ? (
          <ul className="flex flex-col gap-sp-3" data-testid="published-assignments-list">
            {schedule.assignments.map((assignment) => (
              <li
                className="rounded-panel border border-border bg-surface-raised p-sp-3"
                data-testid={`published-assignment-${assignment.assignmentIdentityId}`}
                key={assignment.assignmentIdentityId}
              >
                <h3 className="font-semibold text-text">
                  {assignment.displayName ?? 'A member no longer listed'}
                </h3>
                <dl className="mt-sp-2 flex flex-col gap-sp-1 text-sm">
                  <div className="flex gap-sp-2">
                    <dt className="text-text-muted">Date</dt>
                    <dd className="text-text">{assignment.date}</dd>
                  </div>
                  <div className="flex gap-sp-2">
                    <dt className="text-text-muted">Shift</dt>
                    <dd className="text-text">
                      {codeById.get(assignment.shiftTypeId) ?? 'a retired shift type'}
                    </dd>
                  </div>
                  <div className="flex gap-sp-2">
                    <dt className="text-text-muted">Hours</dt>
                    <dd className="text-text">
                      {timeIn(assignment.startsAt, schedule.timezone)}–
                      {timeIn(assignment.endsAt, schedule.timezone)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <div className="min-w-0 overflow-x-auto" tabIndex={0}>
            <table className="w-full border-collapse text-left" data-testid="published-assignments-table">
              <caption className="sr-only">
                Every assignment in the current published version, in the group time zone{' '}
                {schedule.timezone}
              </caption>
              <thead>
                <tr>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Date
                  </th>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Shift
                  </th>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Hours
                  </th>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Who
                  </th>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {schedule.assignments.map((assignment) => (
                  <tr
                    data-testid={`published-assignment-${assignment.assignmentIdentityId}`}
                    key={assignment.assignmentIdentityId}
                  >
                    <td className="border-b border-border p-sp-2 text-text">{assignment.date}</td>
                    <td className="border-b border-border p-sp-2 text-text">
                      {codeById.get(assignment.shiftTypeId) ?? 'a retired shift type'}
                    </td>
                    <td className="border-b border-border p-sp-2 text-text">
                      {timeIn(assignment.startsAt, schedule.timezone)}–
                      {timeIn(assignment.endsAt, schedule.timezone)}
                    </td>
                    <td className="border-b border-border p-sp-2 text-text">
                      {assignment.displayName ?? 'A member no longer listed'}
                    </td>
                    <td className="border-b border-border p-sp-2 text-text">
                      {[
                        assignment.isPinned ? 'pinned' : null,
                        assignment.overrideReasonGiven ? 'overridden with a reason' : null,
                      ]
                        .filter((note) => note !== null)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
