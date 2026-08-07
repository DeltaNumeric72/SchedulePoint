import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { JSX } from 'react';
import type { AuditEventList, PublishedSchedule } from '@schedulepoint/contracts';

import { ApiError } from '../api/client.js';
import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import { SECONDARY_BUTTON_CLASS } from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { fetchAuditEvents, fetchPublicationRecords, fetchPublishedSchedule } from './api.js';
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
 * ## TWO tables, and each says which one it is
 *
 * OPUS-M3-005 shipped one — `publication_records`, the publication module's own
 * append-only account of what it did (no UPDATE or DELETE grant exists on it,
 * D-15d) — because there was no audit read API and reaching into the frozen
 * audit module would have been the wrong fix. It escalated; FAD-26 recorded the
 * gap; OPUS-M3-008 built the read surface.
 *
 * So the audit-chain table is now here too, and **the publication-records table
 * stays**, with its labelling intact. They are not redundant and the difference
 * is worth a reader's attention:
 *
 * | Table | Is | Answers |
 * |---|---|---|
 * | Publication records | the publication module's own row per publication | "what did the publication transaction record about itself?" |
 * | Audit chain | hash-chained `audit_events`, the tamper-evident history | "what does the chain say happened, and to what?" |
 *
 * The audit chain is gated on `audit.read`, which **no role holds** — it is
 * granted. A scheduler without the grant sees a stated not-authorized panel
 * rather than an error, and everything else on the page still loads.
 *
 * **Reading is not verifying.** This surface never claims the chain is intact:
 * verification is organization-scoped, lives in the maintenance plane, and would
 * report false gaps from a group context — which is exactly why
 * `app_verify_audit_chain` now refuses one (migration 0011).
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

  /* The audit chain for the CURRENT published version. Narrowed by subject
   * rather than fetched whole: this page is about one period's publication, and
   * an unfiltered read would put unrelated history in front of a reader who came
   * here to answer one question. */
  const currentVersionId = published.data?.version?.id;
  const auditEvents = useQuery({
    queryKey: ['audit-events', scope.organizationId, scope.groupId, currentVersionId],
    queryFn: () =>
      fetchAuditEvents(scope, {
        subjectType: 'schedule_version',
        ...(currentVersionId === undefined ? {} : { subjectId: currentVersionId }),
        limit: 50,
      }),
    enabled: currentVersionId !== undefined,
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
          not the audit chain, which is shown separately below.
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

      <AuditChainSection query={auditEvents} />
    </PublicationLayout>
  );
}

/**
 * The audit chain for the current published version.
 *
 * A denial is rendered as a STATED panel rather than as an error, because "you
 * are not granted this" is a normal answer here: `audit.read` is held by no role
 * and the rest of the page is unaffected by its absence. An error panel would
 * teach a scheduler that the page is broken.
 *
 * Nothing here claims the chain verifies. The note says what the sequence gaps
 * mean, because a group-scoped read of an organization-wide sequence has them by
 * construction and an unexplained gap in an audit table is exactly the thing
 * that produces a false alarm.
 */
function AuditChainSection({
  query,
}: {
  query: UseQueryResult<AuditEventList, Error>;
}): JSX.Element {
  const denied = query.error instanceof ApiError && query.error.code === 'FORBIDDEN';

  return (
    <section aria-labelledby="audit-chain-heading" className="flex min-w-0 flex-col gap-sp-2">
      <h2 className="text-lg font-semibold text-text" id="audit-chain-heading">
        Audit chain
      </h2>
      <p className="text-sm text-text-muted" data-testid="audit-scope-note">
        The hash-chained audit events for this version, as recorded. Sequence numbers run across the
        whole organization, so the numbers below have gaps — that is expected in a group-scoped
        read and is not a sign of damage. This is a read of the chain, not a verification of it.
      </p>

      {/* N-6. The server MEASURES truncation (it reads one row past the limit
          rather than inferring it from a full page), and the first version of
          this surface threw that away — so a reader who had more history than
          fits was shown a partial list that looked complete. That is the one
          thing an audit surface must never do. */}
      {query.data?.truncated === true ? (
        <p className="text-text" data-testid="audit-truncated">
          Showing the {query.data.events.length} most recent events for this version. There are
          more — this is not the whole history.
        </p>
      ) : null}

      {denied ? (
        <p className="text-text" data-testid="audit-denied">
          You do not have the audit-read permission for this group, so the chain is not shown.
          Everything else on this page is unaffected.
        </p>
      ) : (
        <SurfaceState
          isLoading={query.isPending}
          error={query.error}
          isEmpty={query.data !== undefined && query.data.events.length === 0}
          emptyMessage="No audit events are recorded against this version."
          label="the audit chain"
        >
          {query.data === undefined ? null : (
            <div className="min-w-0 overflow-x-auto" tabIndex={0}>
              <table className="w-full border-collapse text-left" data-testid="audit-table">
                <caption className="sr-only">
                  Audit events recorded against the current published version, newest first
                </caption>
                <thead>
                  <tr>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Sequence
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Event
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Occurred
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Actor
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.events.map((event) => (
                    <tr data-testid={`audit-event-${event.id}`} key={event.id}>
                      <th
                        className="border-b border-border p-sp-2 font-medium text-text"
                        scope="row"
                      >
                        {event.sequence}
                      </th>
                      <td className="border-b border-border p-sp-2 text-text">{event.eventName}</td>
                      <td className="border-b border-border p-sp-2 text-text">
                        {event.occurredAt}
                      </td>
                      <td className="border-b border-border p-sp-2 text-text">
                        {event.actorDisplayName ?? event.actorKind}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SurfaceState>
      )}
    </section>
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
