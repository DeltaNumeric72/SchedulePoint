import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState, type JSX } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import { CONTROL_CLASS } from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { fetchAffectedStaff, fetchVersionComparison, fetchVersionHistory } from './api.js';
import { AffectedStaffList, DifferenceView } from './DifferenceView.js';
import { PublicationLayout, publicationSections } from './PublicationLayout.js';

/**
 * Compare two versions, and read the affected-staff difference (OPUS-M3-005).
 *
 * ## Two reads of the same difference, deliberately
 *
 * The comparison renders the change-level view — which assignment differs, on
 * which date, for whom. The affected-staff panel renders the person-level view —
 * who has a stake in the change set at all. They come from two endpoints over
 * the same pure function rather than from one endpoint filtered in the browser,
 * because the affected set is what a notification fan-out would use and it has
 * to be answerable on its own: "who would be told about this?" must not depend
 * on a client having fetched the whole change list first.
 *
 * ## The default comparison is what actually happened
 *
 * With no explicit `againstVersionId`, the server compares a version against the
 * one it SUPERSEDED, read from `version_supersessions` — the append-only record
 * of what happened — rather than against `cloned_from_version_id`, which records
 * where the content came from and is a different question. A first publication
 * has no predecessor and correctly renders every assignment as added.
 *
 * ## Nothing on this page writes
 *
 * Comparison is a read of two immutable records. There is no control here that
 * mutates anything, and no route this page calls can.
 */

export function VersionComparisonPage(): JSX.Element {
  const scope = useGroupScope();
  const params = useParams({ strict: false }) as { versionId?: string };
  const versionId = params.versionId ?? '';
  const [against, setAgainst] = useState<string>('');

  const comparison = useQuery({
    queryKey: ['version-comparison', scope.organizationId, scope.groupId, versionId, against],
    queryFn: () =>
      fetchVersionComparison(scope, versionId, against === '' ? undefined : against),
    retry: false,
  });

  const affected = useQuery({
    queryKey: ['affected-staff', scope.organizationId, scope.groupId, versionId, against],
    queryFn: () => fetchAffectedStaff(scope, versionId, against === '' ? undefined : against),
    retry: false,
  });

  const periodId = comparison.data?.toVersion.periodId ?? null;

  const history = useQuery({
    queryKey: ['publication-history', scope.organizationId, scope.groupId, periodId ?? ''],
    queryFn: () => fetchVersionHistory(scope, periodId ?? ''),
    enabled: periodId !== null,
    retry: false,
  });

  return (
    <PublicationLayout
      description="Exactly what differs between two versions of this period, and who has a stake in the difference."
      sections={publicationSections(scope, periodId, 'comparison')}
      title="Compare versions"
    >
      <SurfaceState
        isLoading={comparison.isPending}
        error={comparison.error}
        isEmpty={false}
        emptyMessage="There is nothing to compare."
        label="the version comparison"
      >
        {comparison.data === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-sp-5">
            <section aria-labelledby="comparison-heading" className="flex flex-col gap-sp-2">
              <h2 className="text-lg font-semibold text-text" id="comparison-heading">
                {comparison.data.fromVersion === null
                  ? `Version ${String(comparison.data.toVersion.versionNumber ?? 0)} against nothing`
                  : `Version ${String(
                      comparison.data.fromVersion.versionNumber ?? 0,
                    )} → version ${String(comparison.data.toVersion.versionNumber ?? 0)}`}
              </h2>
              <p className="text-text-muted" data-testid="comparison-summary">
                {comparison.data.fromVersion === null
                  ? 'There is no earlier version to compare against, so every assignment counts as added.'
                  : 'Both versions are permanent records. Comparing them changes nothing.'}{' '}
                Times shown in {comparison.data.timezone}.
              </p>

              {history.data === undefined ? null : (
                <p className="flex flex-wrap items-center gap-sp-2">
                  <label className="text-text" htmlFor="comparison-against">
                    Compare against
                  </label>
                  <select
                    className={CONTROL_CLASS}
                    data-testid="comparison-against"
                    id="comparison-against"
                    onChange={(event) => setAgainst(event.target.value)}
                    value={against}
                  >
                    <option value="">the version it replaced</option>
                    {history.data.versions
                      .filter((version) => version.id !== versionId)
                      .map((version) => (
                        <option key={version.id} value={version.id}>
                          {version.versionNumber === null
                            ? 'an unpublished draft'
                            : `version ${String(version.versionNumber)}`}
                        </option>
                      ))}
                  </select>
                </p>
              )}
            </section>

            <DifferenceView
              difference={comparison.data.difference}
              testId="comparison-diff"
              timezone={comparison.data.timezone}
            />

            <section aria-labelledby="affected-read-heading" className="flex flex-col gap-sp-2">
              <h2 className="text-lg font-semibold text-text" id="affected-read-heading">
                Affected staff
              </h2>
              <p className="text-sm text-text-muted" data-testid="affected-read-note">
                Read separately from the change list: this is the set of people a publication of this
                difference would concern.
              </p>
              <SurfaceState
                isLoading={affected.isPending}
                error={affected.error}
                isEmpty={false}
                emptyMessage="No affected staff."
                label="the affected-staff difference"
              >
                {affected.data === undefined ? null : (
                  <>
                    <p className="text-text" data-testid="affected-read-count">
                      {affected.data.affectedMembers.length === 1
                        ? '1 person is affected'
                        : `${String(affected.data.affectedMembers.length)} people are affected`}{' '}
                      by {affected.data.changeCount === 1 ? '1 change' : `${String(affected.data.changeCount)} changes`}.
                    </p>
                    <AffectedStaffList
                      members={affected.data.affectedMembers}
                      testId="affected-read-list"
                    />
                  </>
                )}
              </SurfaceState>
            </section>
          </div>
        )}
      </SurfaceState>
    </PublicationLayout>
  );
}
