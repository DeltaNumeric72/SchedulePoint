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

  /**
   * The ONE verdict every section on this page answers to (REPAIR F-01/F-02,
   * FAD-46).
   *
   * It is read once, here, rather than re-derived per section — a page where one
   * section consults the verdict and another quietly does not is exactly how a
   * refusal ended up printed above an affirmative claim that the candidates were
   * identical. Defaulting to `true` before the data arrives is safe because
   * nothing below renders at all until `comparison.data` is defined.
   */
  const comparable =
    comparison.data === undefined ? true : comparison.data.comparability.comparable;

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
                {comparison.data.comparability.comparable ? (
                  <p className="text-sm text-text-muted" data-testid="build-comparison-shared">
                    {comparison.data.sharedAssignmentCount} placements are identical across every
                    candidate shown.
                  </p>
                ) : (
                  /* OPUS-M4-004. A refusal, stated — not an empty table. Two
                     candidates are comparable only against the same canonical
                     snapshot AND the same objective weights; anything else puts
                     answers to two different questions in one column. */
                  <p
                    className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
                    data-testid={`build-comparison-refused-${comparison.data.comparability.reason}`}
                    role="alert"
                  >
                    {comparison.data.comparability.reason === 'cross-snapshot'
                      ? 'These candidates were built from different problems — different periods, demand, rosters or rules. Their placements cannot be compared, because a difference between them is a difference of input, not of choice.'
                      : 'These candidates were optimised under different objective weights. Their measurements cannot be compared, because they are answers to different questions.'}
                  </p>
                )}
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
                {!comparable ? (
                  /* REPAIR F-02 (FAD-46). These numbers were measured against
                     different problems, or under different objective weights.
                     One column each, side by side, is the arrangement that says
                     "compare these" — putting them there UNDER a refusal invites
                     exactly the read the refusal exists to prevent. They are
                     still each a fact about their own candidate, so they are
                     shown SEPARATELY, each labelled with the objective it was
                     measured under. */
                  <div
                    className="flex flex-col gap-sp-3"
                    data-testid="build-comparison-quality-separated"
                  >
                    <p className="text-sm text-text" role="note">
                      Because these candidates cannot be compared, their measurements are shown
                      separately — one candidate at a time, each against the objective it was
                      actually measured under. They are not a comparison, and reading down them as
                      if they were one would be reading answers to different questions.
                    </p>
                    {comparison.data.quality.map((entry) => {
                      const run = comparison.data.runs.find((item) => item.id === entry.runId);
                      return (
                        <div className="min-w-0 overflow-x-auto" key={entry.runId} tabIndex={0}>
                          <table
                            className="w-full border-collapse text-left"
                            data-testid={`build-comparison-quality-single-${entry.runId}`}
                          >
                            <caption className="p-sp-2 text-left text-sm font-medium text-text">
                              {run?.candidateLabel ?? entry.runId}
                              <span className="font-normal text-text-muted">
                                {' '}
                                · measured under{' '}
                                {entry.quality.objectiveProfileId || 'an unrecorded objective'}
                                {entry.quality.objectiveWeightsDigest === null
                                  ? ''
                                  : ` ${entry.quality.objectiveWeightsDigest.slice(0, 8)}…`}
                              </span>
                            </caption>
                            <tbody>
                              <tr>
                                <th className="border-b border-border p-sp-2" scope="row">
                                  Filled / required
                                </th>
                                <td className="border-b border-border p-sp-2 text-text">
                                  {entry.quality.filledSlots} / {entry.quality.requiredSlots}
                                </td>
                              </tr>
                              <tr>
                                <th className="border-b border-border p-sp-2" scope="row">
                                  Hard violations
                                </th>
                                <td className="border-b border-border p-sp-2 text-text">
                                  {entry.quality.hardViolations}
                                </td>
                              </tr>
                              <tr>
                                <th className="border-b border-border p-sp-2" scope="row">
                                  Soft penalty
                                </th>
                                <td className="border-b border-border p-sp-2 text-text">
                                  {entry.quality.softPenaltyTotal ?? '—'}
                                </td>
                              </tr>
                              <tr>
                                <th className="border-b border-border p-sp-2" scope="row">
                                  Fairness dispersion
                                </th>
                                <td className="border-b border-border p-sp-2 text-text">
                                  {entry.quality.fairnessDispersion === null
                                    ? '—'
                                    : `${entry.quality.fairnessDispersion.toFixed(3)} (${entry.quality.fairnessNormalisation})`}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                  </div>
                ) : (
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
                          {/* OPUS-M4-004: a soft penalty is only readable beside
                            the objective it was measured under, and a fairness
                            dispersion only beside its normalisation. */}
                          <th className="border-b border-border p-sp-2" scope="col">
                            Fairness dispersion
                          </th>
                          <th className="border-b border-border p-sp-2" scope="col">
                            Objective
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
                              <td className="border-b border-border p-sp-2 text-text">
                                {entry.quality.fairnessDispersion === null
                                  ? '—'
                                  : `${entry.quality.fairnessDispersion.toFixed(3)} (${entry.quality.fairnessNormalisation})`}
                              </td>
                              <td className="border-b border-border p-sp-2 text-text-muted">
                                {entry.quality.objectiveProfileId || '—'}
                                {entry.quality.objectiveWeightsDigest === null
                                  ? ''
                                  : ` ${entry.quality.objectiveWeightsDigest.slice(0, 8)}…`}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section aria-labelledby="differences-heading" className="flex flex-col gap-sp-2">
                <h2 className="text-lg font-semibold text-text" id="differences-heading">
                  Where they differ
                </h2>
                {!comparable ? (
                  /* REPAIR F-01 (FAD-46). The projection is EMPTY on a refusal —
                     not because the candidates agree, but because no comparison
                     was performed. Falling through to the empty-list branch
                     printed "These candidates place everybody identically", an
                     affirmative factual claim about two schedules nobody had
                     compared, directly beneath the notice saying they could not
                     be. An absence of computed differences is not agreement, and
                     this is the branch that has to say so. */
                  <p
                    className="text-text"
                    data-testid="build-comparison-differences-withheld"
                    role="note"
                  >
                    No differences are shown, because no comparison was made. This is not a
                    statement that the candidates agree — it is the absence of a comparison, and the
                    two look identical only on a screen that confuses them.
                  </p>
                ) : comparison.data.differences.length === 0 ? (
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
