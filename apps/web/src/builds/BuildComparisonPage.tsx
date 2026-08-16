import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { BuildsLayout, STATE_LABELS } from './BuildsLayout.js';
import { fetchComparison } from './api.js';

/**
 * D-4c: the candidate comparison, as a READ-ONLY projection (OPUS-M4-003).
 *
 * ## It reports; it does not rank
 *
 * SPEC-04 §7 is explicit that every quality band except `hard_violations = 0` is
 * **undefined** until the benchmark corpus is run. A "best candidate" badge here
 * would be an invented threshold wearing a number's clothes, and it would be
 * believed. So the surface shows what differs and what each candidate measured,
 * and the scheduler decides.
 *
 * ## Only the differences
 *
 * A thousand identical placements shown to prove two candidates agree would bury
 * the six that do not — which is the whole question a comparison is asked.
 */

export function BuildComparisonPage(): JSX.Element {
  const scope = useGroupScope();
  const search = useSearch({ strict: false }) as { runIds?: string };
  const narrow = useNarrowViewport();
  const runIds = (search.runIds ?? '').split(',').filter((id) => id.length > 0);

  const comparison = useQuery({
    queryKey: ['build-comparison', scope.organizationId, scope.groupId, runIds.join(',')],
    queryFn: async () => fetchComparison(scope, runIds),
    enabled: runIds.length >= 2,
    retry: false,
  });

  return (
    <BuildsLayout
      title="Compare candidates"
      description="Where these candidates place people differently, and what each one measured."
      periodId={comparison.data?.runs[0]?.periodId ?? null}
    >
      {runIds.length < 2 ? (
        <p className="text-text" data-testid="build-comparison-too-few">
          Choose at least two candidates to compare.
        </p>
      ) : (
        <SurfaceState
          isLoading={comparison.isPending}
          error={comparison.error}
          isEmpty={false}
          emptyMessage="There is nothing to compare."
          label="the candidate comparison"
        >
          {comparison.data === undefined ? null : (
            <>
              <section aria-labelledby="candidates-heading" className="flex flex-col gap-sp-2">
                <h2 className="text-lg font-semibold text-text" id="candidates-heading">
                  Candidates
                </h2>
                <ul className="flex flex-col gap-sp-1" data-testid="build-comparison-runs">
                  {comparison.data.runs.map((run) => (
                    <li className="text-text" key={run.id}>
                      <span className="font-medium">{run.candidateLabel}</span>{' '}
                      <span className="text-text-muted">
                        · {run.configurationName} · {STATE_LABELS[run.state]}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-text-muted" data-testid="build-comparison-shared">
                  {comparison.data.sharedAssignmentCount} placements are identical across every
                  candidate shown.
                </p>
              </section>

              <section aria-labelledby="quality-heading" className="flex flex-col gap-sp-2">
                <h2 className="text-lg font-semibold text-text" id="quality-heading">
                  Measurements
                </h2>
                <p className="text-sm text-text-muted" data-testid="build-comparison-caveat">
                  These are measurements, not ratings. Acceptable ranges for everything except “hard
                  violations must be zero” are not established yet, so nothing here says which
                  candidate is better.
                </p>
                <div className="min-w-0 overflow-x-auto" tabIndex={0}>
                  <table
                    className="w-full border-collapse text-left"
                    data-testid="build-comparison-quality"
                  >
                    <caption className="sr-only">Measured quality per candidate</caption>
                    <thead>
                      <tr>
                        <th className="border-b border-border p-sp-2" scope="col">
                          Candidate
                        </th>
                        <th className="border-b border-border p-sp-2" scope="col">
                          Filled / required
                        </th>
                        <th className="border-b border-border p-sp-2" scope="col">
                          Hard violations
                        </th>
                        <th className="border-b border-border p-sp-2" scope="col">
                          Soft penalty
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.data.quality.map((entry) => {
                        const run = comparison.data.runs.find((item) => item.id === entry.runId);
                        return (
                          <tr key={entry.runId}>
                            <td className="border-b border-border p-sp-2 text-text">
                              {run?.candidateLabel ?? entry.runId}
                            </td>
                            <td className="border-b border-border p-sp-2 text-text">
                              {entry.quality.filledSlots} / {entry.quality.requiredSlots}
                            </td>
                            <td className="border-b border-border p-sp-2 text-text">
                              {entry.quality.hardViolations}
                            </td>
                            <td className="border-b border-border p-sp-2 text-text">
                              {entry.quality.softPenaltyTotal ?? '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section aria-labelledby="differences-heading" className="flex flex-col gap-sp-2">
                <h2 className="text-lg font-semibold text-text" id="differences-heading">
                  Where they differ
                </h2>
                {comparison.data.differences.length === 0 ? (
                  <p className="text-text" data-testid="build-comparison-identical">
                    These candidates place everybody identically.
                  </p>
                ) : narrow ? (
                  <ul className="flex flex-col gap-sp-2" data-testid="build-comparison-list">
                    {comparison.data.differences.map((row, index) => (
                      <li
                        className="flex flex-col gap-sp-1 rounded-panel border border-border bg-surface-raised p-sp-3"
                        key={`${row.membershipId}-${row.date}-${String(index)}`}
                      >
                        <span className="text-text">{row.date}</span>
                        <span className="text-sm text-text-muted">
                          in {row.inRunIds.length} of {comparison.data.runs.length} candidates
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="min-w-0 overflow-x-auto" tabIndex={0}>
                    <table
                      className="w-full border-collapse text-left"
                      data-testid="build-comparison-differences"
                    >
                      <caption className="sr-only">
                        Placements that differ between the compared candidates
                      </caption>
                      <thead>
                        <tr>
                          <th className="border-b border-border p-sp-2" scope="col">
                            Date
                          </th>
                          <th className="border-b border-border p-sp-2" scope="col">
                            Participant
                          </th>
                          <th className="border-b border-border p-sp-2" scope="col">
                            Present in
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.data.differences.map((row, index) => (
                          <tr key={`${row.membershipId}-${row.date}-${String(index)}`}>
                            <td className="border-b border-border p-sp-2 text-text">{row.date}</td>
                            <td className="border-b border-border p-sp-2 text-text-muted">
                              {row.membershipId}
                            </td>
                            <td className="border-b border-border p-sp-2 text-text">
                              {row.inRunIds
                                .map(
                                  (id) =>
                                    comparison.data.runs.find((item) => item.id === id)
                                      ?.candidateLabel ?? id,
                                )
                                .join(', ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </SurfaceState>
      )}
    </BuildsLayout>
  );
}
