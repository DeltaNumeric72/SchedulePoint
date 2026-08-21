import type { BuildFinding, BuildRunDetail } from '@schedulepoint/contracts';
import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../components/Form.js';
import { isPermissionDenied, SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import {
  BuildsLayout,
  CONFLICT_CLASS_EXPLANATIONS,
  CONFLICT_CLASS_LABELS,
  EXPLANATION_DETAIL,
  EXPLANATION_LABELS,
  RESULT_REPRODUCIBILITY_LABELS,
  STALENESS_DIRECTION_LABELS,
  STATE_EXPLANATIONS,
  STATE_LABELS,
  TERMINATION_LABELS,
} from './BuildsLayout.js';
import {
  applyBuild,
  BuildSourceMovedError,
  BuildStateMovedError,
  fetchRun,
  retryBuild,
  runBuild,
  transitionRun,
} from './api.js';

/**
 * One build: what it is doing, what it found, and what may be done with it
 * (OPUS-M4-003).
 *
 * ## Every state has words, and the words never collapse
 *
 * `STATE_LABELS` and `STATE_EXPLANATIONS` live in the layout so that one table
 * governs the whole surface. The two that matter most are `infeasible` and
 * `failed`: report 21 §4 requires them to stay apart, and a distinction the
 * interface does not make is a distinction that does not exist for the person
 * reading it.
 *
 * ## The degraded explanation states are shown, not hidden
 *
 * SPEC-04 §5: `EXPLANATION_BUDGET_EXCEEDED` and `EXPLANATION_UNAVAILABLE` are
 * first-class outcomes. "We could not isolate the cause within the budget, here
 * is what we do know" is more useful than a screen that appears to hang or a
 * confident-sounding answer that is wrong.
 *
 * ## Two irreversible-ish acts get friction
 *
 * Cancelling a running solve and applying a candidate to a new draft both open a
 * confirmation panel first — local state, zero requests — and the confirm button
 * is disabled while the request is in flight, because a second click must not
 * become a second request.
 */

function FindingList({
  findings,
  testId,
}: {
  findings: readonly BuildFinding[];
  testId: string;
}): JSX.Element | null {
  if (findings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-sp-1" data-testid={testId}>
      {findings.map((finding, index) => (
        <li className="text-sm text-text" key={`${finding.code}-${String(index)}`}>
          <span className="font-medium">{finding.code}</span>
          {finding.date === null ? null : (
            <span className="text-text-muted"> · {finding.date}</span>
          )}
          <span className="text-text-muted"> — {finding.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The states from which a retry is offered (FAD-45(2)).
 *
 * One set, so the CONTROL and its EXHAUSTION REASON cannot disagree about where
 * a retry is possible — which is exactly what D-2 found: the control appeared
 * for three states and the reason for one, so an `infeasible` build with a spent
 * chain showed a disabled button and no explanation.
 *
 * `infeasible` is included deliberately: report 21 draws "relax constraints and
 * retry" from that state, and although the EDGE is not in-place (SPEC-04 §2),
 * re-posing the problem after changing the inputs is what a scheduler does next.
 */
const RETRYABLE_STATES: ReadonlySet<BuildRunDetail['run']['state']> = new Set([
  'failed',
  'cancelled',
  'infeasible',
]);

export function BuildDetailPage(): JSX.Element {
  const scope = useGroupScope();
  const { buildRunId } = useParams({ strict: false }) as { buildRunId?: string };
  const runId = buildRunId ?? '';
  const queryClient = useQueryClient();
  const narrow = useNarrowViewport();

  const detail = useQuery({
    queryKey: ['build-run', scope.organizationId, scope.groupId, runId],
    queryFn: async () => fetchRun(scope, runId),
    enabled: runId !== '',
    retry: false,
  });

  const [message, setMessage] = useState<string | null>(null);
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const [sourceMoved, setSourceMoved] = useState(false);
  const [isConfirmingCancel, setIsConfirmingCancel] = useState(false);
  const [isConfirmingApply, setIsConfirmingApply] = useState(false);
  const [appliedVersionId, setAppliedVersionId] = useState<string | null>(null);
  const [retriedRunId, setRetriedRunId] = useState<string | null>(null);
  /* One key per page view, not per click: a second click must not become a
   * second build (D-17). Regenerated when a retry succeeds, because the next
   * retry is a genuinely different request. */
  const [retryKey, setRetryKey] = useState(
    () => `ui.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`,
  );

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['build-run'] });
    void queryClient.invalidateQueries({ queryKey: ['build-runs'] });
  };

  const onError = (error: unknown): void => {
    if (error instanceof BuildStateMovedError) {
      setMovedTo(error.currentState);
      setMessage(null);
      return;
    }
    if (error instanceof BuildSourceMovedError) {
      setSourceMoved(true);
      setMessage(null);
      return;
    }
    setMovedTo(null);
    setMessage(
      isPermissionDenied(error)
        ? 'You do not have permission to act on builds in this group.'
        : (error as Error).message,
    );
  };

  const move = useMutation({
    mutationFn: async (input: {
      action: 'submit' | 'cancel' | 'review' | 'extend' | 'stage-complete' | 'approve';
      expected: BuildRunDetail['run']['state'];
    }) => transitionRun(scope, runId, input.action, input.expected),
    onSuccess: () => {
      setIsConfirmingCancel(false);
      setMessage(null);
      setMovedTo(null);
      invalidate();
    },
    onError,
  });

  const start = useMutation({
    mutationFn: async () => runBuild(scope, runId),
    onSuccess: () => {
      setMessage(null);
      setMovedTo(null);
      invalidate();
    },
    onError,
  });

  /**
   * **Retry** (FAD-45(2)). A NEW build carrying `retryOfBuildRunId` — never a
   * transition of this one, because SPEC-04 §2 forbids an in-place retry and the
   * record of what really happened is the reason.
   */
  const retry = useMutation({
    mutationFn: async () => {
      if (run === undefined) throw new Error('no build to retry');
      return retryBuild(
        scope,
        {
          id: run.id,
          configurationId: run.configurationId,
          sourceVersionId: run.sourceVersionId,
          candidateLabel: run.candidateLabel,
        },
        retryKey,
      );
    },
    onSuccess: (result) => {
      setRetriedRunId(result.run.id);
      setMessage(null);
      setRetryKey(`ui.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`);
      invalidate();
    },
    onError: (error: unknown) => {
      /* The bound is the server's and the surface states it plainly rather than
       * hiding the control — a scheduler must learn the chain is spent, not
       * press a button that quietly does nothing. */
      setMessage(
        isPermissionDenied(error)
          ? 'You do not have permission to start builds in this group.'
          : 'This build could not be retried. Its chain may have used all of its retries.',
      );
    },
  });

  const apply = useMutation({
    mutationFn: async (digest: string) =>
      applyBuild(scope, runId, { expectedState: 'approved', expectedSourceDigest: digest }),
    onSuccess: (result) => {
      setIsConfirmingApply(false);
      setSourceMoved(false);
      setAppliedVersionId(result.draftVersionId);
      invalidate();
    },
    onError,
  });

  const data = detail.data;
  const run = data?.run;

  return (
    <BuildsLayout
      title="Build"
      description="What this build is doing, what it found, and what may be done with it."
      periodId={run?.periodId ?? null}
    >
      <SurfaceState
        isLoading={detail.isPending}
        error={detail.error}
        isEmpty={false}
        emptyMessage="This build has no detail yet."
        label="this build"
      >
        {data === undefined || run === undefined ? null : (
          <>
            {/* ── the state, in words ─────────────────────────────────────── */}
            <section
              aria-labelledby="state-heading"
              className="flex flex-col gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-4"
            >
              <h2 className="text-lg font-semibold text-text" id="state-heading">
                {STATE_LABELS[run.state]}
              </h2>
              <p className="text-text-muted" data-testid={`build-state-${run.state}`}>
                {STATE_EXPLANATIONS[run.state]}
              </p>
              {run.terminationReason === null ? null : (
                <p className="text-sm text-text-muted" data-testid="build-termination-reason">
                  {/* FAD-34, unabridged: a deadline, a kill, a crash and a
                      refusal are four different things and are said as four. */}
                  This build {TERMINATION_LABELS[run.terminationReason] ?? run.terminationReason}
                  {run.solverStatus === null ? '' : ` (solver status ${run.solverStatus})`}.
                </p>
              )}
              <p className="text-sm text-text-muted">
                Candidate <span className="font-medium">{run.candidateLabel}</span> · configuration{' '}
                {run.configurationName} · attempt {run.retryAttempt} of {run.retryLimit}
                {run.canonicalInputHash === null
                  ? null
                  : ` · input ${run.canonicalInputHash.slice(0, 12)}…`}
              </p>
              {/* OPUS-M4-004. `reproducibility` has been on the wire since
                  0018 and was never rendered, so a build that could be
                  reproduced and one that could not looked identical.

                  OPUS-M4-005 continuation (FAD-49, EV-M4-005 §21). It is now
                  the RESULT-side verdict that is rendered, not the dispatch
                  mode. This screen is about a run that has finished, and the
                  dispatch mode cannot see how the search ended: a build posed
                  `deterministic` whose wall clock ran out reproduces nothing,
                  and used to read here as "Deterministic — reproducible. The
                  same problem run again … produces the same schedule." The
                  verdict carries its own reason, so the screen states it rather
                  than inventing one. */}
              {data.resultReproducibility === null ? null : (
                <p
                  className="text-sm text-text-muted"
                  data-testid={`build-reproducibility-${data.resultReproducibility.verdict}`}
                >
                  {RESULT_REPRODUCIBILITY_LABELS[data.resultReproducibility.verdict] ??
                    data.resultReproducibility.verdict}
                  . {data.resultReproducibility.detail}
                </p>
              )}
              {/* ── doc 35 §6g ruling 4: staleness is VISIBLE, and it is absolute ──
                  A build whose inputs moved after assembly can never silently
                  become the current draft. The server refuses the selection; this
                  is what tells a scheduler BEFORE they decide, rather than after
                  they have clicked and been refused.
                  `role="alert"` because the whole point is that it must not be
                  possible to read this screen and not know. */}
              {data.staleness.stale ? (
                <div
                  className="flex flex-col gap-sp-1 rounded-panel border border-border bg-surface-raised p-sp-4"
                  data-testid="build-staleness"
                  role="alert"
                >
                  <p className="text-text">
                    The inputs this build was posed against have changed since it was assembled.
                    This candidate cannot be written to a draft — run a new build.
                  </p>
                  {data.staleness.assemblyRefusals.length > 0 ? (
                    <p
                      className="text-sm text-text-muted"
                      data-testid="build-staleness-unassemblable"
                    >
                      The inputs can no longer be assembled at all:{' '}
                      {data.staleness.assemblyRefusals.join(', ')}.
                    </p>
                  ) : (
                    <>
                      {/* FAD-51 D-2. The list is ALWAYS grouped by input class
                          now, so the sentence says so unconditionally. The
                          previous version showed that clause only when
                          `changeCount > changes.length` — a comparison between a
                          change TOTAL and a CLASS-LIST length, two different
                          units, which happened to read correctly only while the
                          per-class counts were themselves truncated. The counts
                          now sum to `changeCount`, so the sentence and the list
                          below it reconcile for every input. */}
                      <p className="text-sm text-text-muted">
                        {data.staleness.changeCount} input revision
                        {data.staleness.changeCount === 1 ? '' : 's'} moved, grouped below by
                        input class.
                      </p>
                      <ul
                        className="flex flex-col gap-sp-1 text-sm text-text-muted"
                        data-testid="build-staleness-changes"
                      >
                        {/* FAD-50 C-4. Class + direction + count. This used to
                            print `change.key` beside the class, which for the
                            qualificationHolding class was a holding row's
                            surrogate id behind a grant-only capability — and
                            which told a scheduler nothing: it was an opaque
                            UUID. A count is strictly more use and discloses
                            nothing. */}
                        {data.staleness.changes.map((change) => (
                          <li key={`${change.kind}:${change.direction}`}>
                            {change.count} × {change.kind} —{' '}
                            {STALENESS_DIRECTION_LABELS[change.direction]}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ) : null}
              {run.supersededByBuildRunId === null ? null : (
                <p className="text-sm text-text-muted" data-testid="build-superseded-note">
                  A later build for this period was approved, so this one is superseded.
                </p>
              )}
              {run.retryAttempt >= run.retryLimit && RETRYABLE_STATES.has(run.state) ? (
                <p className="text-sm text-text" data-testid="build-retries-exhausted" role="alert">
                  {/* SPEC-04 §2: exhausted retries surface WITH the last reason.
                      Rendered for EVERY state that offers the retry control, not
                      only `failed` (D-2). The disabled-not-hidden rationale is
                      that a scheduler should learn WHY the button will not work
                      — and an `infeasible` or `cancelled` build whose chain is
                      spent showed a disabled control with no explanation, which
                      is the thing that rationale exists to prevent. */}
                  This build chain has used its retries. The last outcome was{' '}
                  {TERMINATION_LABELS[run.terminationReason ?? 'crashed']}.
                </p>
              ) : null}
            </section>

            {/* ── the itemised bounce reasons ─────────────────────────────── */}
            {data.validationFindings.length + data.readinessFindings.length === 0 ? null : (
              <section
                aria-labelledby="findings-heading"
                className="flex flex-col gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-4"
              >
                <h2 className="text-lg font-semibold text-text" id="findings-heading">
                  Why this build went back to configuration
                </h2>
                <FindingList
                  findings={data.validationFindings}
                  testId="build-validation-findings"
                />
                <FindingList findings={data.readinessFindings} testId="build-readiness-findings" />
              </section>
            )}

            {/* ── the result ──────────────────────────────────────────────── */}
            {data.result === null ? (
              <p className="text-text-muted" data-testid="build-no-result">
                This build has not produced a result yet.
              </p>
            ) : (
              <section
                aria-labelledby="result-heading"
                className="flex flex-col gap-sp-3 rounded-panel border border-border bg-surface-raised p-sp-4"
              >
                <h2 className="text-lg font-semibold text-text" id="result-heading">
                  Result
                </h2>

                <p className="text-text" data-testid="build-usability">
                  {data.result.usable
                    ? 'The independent check accepted this candidate. Zero hard violations.'
                    : 'The independent check REFUSED this candidate. It can never become a schedule.'}
                </p>

                <dl
                  className="grid grid-cols-1 gap-sp-2 sm:grid-cols-3"
                  data-testid="build-quality"
                >
                  <div>
                    <dt className="text-sm text-text-muted">Assignments</dt>
                    <dd className="text-text">{data.result.assignmentCount}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Required slots filled</dt>
                    <dd className="text-text">
                      {data.result.quality.filledSlots} of {data.result.quality.requiredSlots}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Hard violations</dt>
                    <dd className="text-text">{data.result.quality.hardViolations}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Soft penalty</dt>
                    <dd className="text-text">
                      {data.result.quality.softPenaltyTotal === null
                        ? 'no objective terms'
                        : data.result.quality.softPenaltyTotal}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Solve time</dt>
                    <dd className="text-text">{data.result.quality.solveWallClockMs} ms</dd>
                  </div>
                  {/* OPUS-M4-004 — the rest of SPEC-04 §7's table. Each one a
                      measurement; `not measured` is written out rather than
                      shown as a zero, because a zero rate is a specific claim. */}
                  <div>
                    <dt className="text-sm text-text-muted">Demand satisfied</dt>
                    <dd className="text-text" data-testid="build-quality-demand">
                      {data.result.quality.demandSatisfactionRate === null
                        ? 'nothing was required'
                        : `${String(Math.round(data.result.quality.demandSatisfactionRate * 100))}%`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Fairness dispersion</dt>
                    <dd className="text-text" data-testid="build-quality-fairness">
                      {data.result.quality.fairnessDispersion === null
                        ? 'not measurable'
                        : data.result.quality.fairnessDispersion.toFixed(3)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Fairness basis</dt>
                    <dd className="text-text" data-testid="build-quality-fairness-basis">
                      {data.result.quality.fairnessNormalisation} ·{' '}
                      {data.result.quality.fairnessMeasuredParticipants} measured
                      {data.result.quality.fairnessUnmeasuredParticipants === 0
                        ? ''
                        : `, ${String(data.result.quality.fairnessUnmeasuredParticipants)} with no FTE on record`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Requests honoured</dt>
                    <dd className="text-text">
                      {data.result.quality.requestHonourRate === null
                        ? 'not measured — requests are not in this milestone'
                        : `${String(Math.round(data.result.quality.requestHonourRate * 100))}%`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Template adherence</dt>
                    <dd className="text-text">
                      {data.result.quality.templateAdherenceRate === null
                        ? 'not measured — templates are not evaluated yet'
                        : `${String(Math.round(data.result.quality.templateAdherenceRate * 100))}%`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-muted">Explanation time</dt>
                    <dd className="text-text">
                      {/* REPAIR F-13 (FAD-46). This said "no explanation was
                          attempted", which is a claim about whether the worker
                          RAN one — and it was printed from a missing LATENCY.
                          A build can carry a populated T2 record directly below
                          this line while its latency is unrecorded, and the two
                          then contradict each other on one screen. An absent
                          measurement is an absent measurement. */}
                      {data.result.quality.explanationLatencyMs === null
                        ? 'not recorded'
                        : `${String(data.result.quality.explanationLatencyMs)} ms`}
                    </dd>
                  </div>
                </dl>
                {/* SPEC-04 §7: every band except `hard_violations = 0` is
                    UNDEFINED until the benchmark corpus is run, and saying so is
                    the honest position. No rating, no colour, no threshold. */}
                <p className="text-sm text-text-muted" data-testid="build-quality-caveat">
                  These are measurements, not ratings. Acceptable ranges for everything except “hard
                  violations must be zero” are not established yet.
                </p>

                {data.result.objectiveTiers.length === 0 ? null : (
                  <>
                    <div className="min-w-0 overflow-x-auto" tabIndex={0}>
                      <table
                        className="w-full border-collapse text-left"
                        data-testid="build-soft-tiers"
                      >
                        <caption className="sr-only">
                          Objective tiers, their weights, and each rule&rsquo;s recorded weight
                        </caption>
                        <thead>
                          <tr>
                            <th className="border-b border-border p-sp-2" scope="col">
                              Rank
                            </th>
                            <th className="border-b border-border p-sp-2" scope="col">
                              Name
                            </th>
                            <th className="border-b border-border p-sp-2" scope="col">
                              Tier weight
                            </th>
                            <th className="border-b border-border p-sp-2" scope="col">
                              Rules and their weights
                            </th>
                            <th className="border-b border-border p-sp-2" scope="col">
                              Terms
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.result.objectiveTiers.map((tier) => (
                            <tr key={`${String(tier.tier)}-${tier.name}`}>
                              <td className="border-b border-border p-sp-2 text-text">
                                {tier.tier}
                              </td>
                              <td className="border-b border-border p-sp-2 text-text">
                                {tier.name}
                              </td>
                              <td className="border-b border-border p-sp-2 text-text">
                                {tier.weightScale}
                              </td>
                              {/* doc 35 §6f behaviour 1: the components AND the
                                  weights, recorded and rendered. A tier list
                                  naming only the rules would let two results
                                  under different weights sit in one column
                                  looking comparable. */}
                              <td className="border-b border-border p-sp-2 text-text-muted">
                                {tier.components.length > 0
                                  ? tier.components
                                      .map(
                                        (component) =>
                                          `${component.ruleKey} ×${String(component.scaledWeight)}`,
                                      )
                                      .join(', ')
                                  : tier.ruleKeys.join(', ') || '—'}
                                {tier.unmappedRuleKeys.length === 0
                                  ? ''
                                  : ` · not modelled: ${tier.unmappedRuleKeys.join(', ')}`}
                              </td>
                              <td className="border-b border-border p-sp-2 text-text">
                                {tier.termCount}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-sm text-text-muted" data-testid="build-objective-record">
                      {/* doc 08 §3.4: one scaling factor, decided once and
                          recorded, so two objective values can be interpreted.
                          The digest is what makes "same weights" checkable. */}
                      Objective profile {data.result.quality.objectiveProfileId || 'unrecorded'},
                      weights ×{data.result.quality.objectiveScale}
                      {data.result.quality.objectiveWeightsDigest === null
                        ? ''
                        : ` · ${data.result.quality.objectiveWeightsDigest.slice(0, 12)}…`}
                      . Weights order the tiers by magnitude; this is a weighted total, not a strict
                      priority between them.
                    </p>
                  </>
                )}

                {data.result.rejections.length === 0 ? null : (
                  /* `role="alert"` sits on the WRAPPER, never on the `<ul>`:
                   * an ARIA role on a list element replaces the list semantics,
                   * so the items stop being list items and a screen-reader user
                   * loses the count. axe catches it (`aria-allowed-role` plus a
                   * serious `listitem`), and it caught this one. */
                  <div data-testid="build-rejections" role="alert">
                    <ul className="flex flex-col gap-sp-1">
                      {data.result.rejections.map((rejection, index) => (
                        <li
                          className="text-sm text-text"
                          key={`${rejection.reason}-${String(index)}`}
                        >
                          <span className="font-medium">{rejection.reason}</span> —{' '}
                          {rejection.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* ── explanation, tiers 1–2, with the degraded states named ── */}
                <div className="flex flex-col gap-sp-1" data-testid="build-explanation">
                  <h3 className="font-medium text-text">Explanation</h3>
                  {data.result.explanation.state === null ? (
                    <p className="text-sm text-text-muted">
                      No explanation was attempted — this build found a schedule.
                    </p>
                  ) : (
                    /* SPEC-04 §5's five states, from the ONE wording table.
                       The nested ternary that used to live here was a second
                       spelling of the same five sentences, which is how one
                       screen's copy drifts from another's. */
                    <>
                      <p
                        className="text-sm font-medium text-text"
                        data-testid={`build-explanation-${data.result.explanation.state}`}
                      >
                        {EXPLANATION_LABELS[data.result.explanation.state]}
                      </p>
                      <p className="text-sm text-text-muted">
                        {EXPLANATION_DETAIL[data.result.explanation.state]}
                      </p>
                    </>
                  )}
                  <FindingList
                    findings={data.result.explanation.structural}
                    testId="build-structural-findings"
                  />
                  {data.result.explanation.conflictingRuleKeys.length === 0 ? null : (
                    <p className="text-sm text-text-muted">
                      Conflicting rules: {data.result.explanation.conflictingRuleKeys.join(', ')}
                    </p>
                  )}
                  {/* What the minimisation actually did, and what stopped it.
                      "Minimised within budget" and "the budget ran out" are the
                      same list of rule keys with two different meanings, and
                      this is the only thing that tells them apart. */}
                  {data.result.explanation.tier2 === null ||
                  !data.result.explanation.tier2.attempted ? null : (
                    <p className="text-sm text-text-muted" data-testid="build-explanation-tier2">
                      Narrowing: {data.result.explanation.tier2.iterations} of at most{' '}
                      {data.result.explanation.tier2.maxIterations} probes,{' '}
                      {data.result.explanation.tier2.removed} rule(s) ruled out
                      {data.result.explanation.tier2.exhausted
                        ? ', and the budget ran out before every remaining rule had been checked'
                        : ', and every remaining rule was checked'}
                      .
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* ── PO-DEC-13's conflict taxonomy ───────────────────────────── */}
            {data.conflicts.length === 0 ? null : (
              <section
                aria-labelledby="conflicts-heading"
                className="flex flex-col gap-sp-3 rounded-panel border border-border bg-surface-raised p-sp-4"
              >
                <h2 className="text-lg font-semibold text-text" id="conflicts-heading">
                  Conflicts
                </h2>
                <p className="text-sm text-text-muted" data-testid="build-conflicts-caveat">
                  Ordered by severity. A fairness outlier is a measurement with no threshold behind
                  it — it never blocks approval.
                </p>
                {(
                  [
                    'hard-breach',
                    'unmet-demand',
                    'eligibility-failure',
                    'fairness-outlier',
                  ] as const
                )
                  .map((conflictClass) => ({
                    conflictClass,
                    items: data.conflicts.filter(
                      (conflict) => conflict.conflictClass === conflictClass,
                    ),
                  }))
                  .filter((group) => group.items.length > 0)
                  .map((group) => (
                    <div
                      className="flex flex-col gap-sp-1"
                      data-testid={`build-conflict-class-${group.conflictClass}`}
                      key={group.conflictClass}
                    >
                      <h3 className="font-medium text-text">
                        {CONFLICT_CLASS_LABELS[group.conflictClass]} ({group.items.length})
                        {/* Words, never colour alone. The blocking/advisory
                            distinction is the one a scheduler acts on. */}
                        {group.items[0]?.blocksApproval === true
                          ? ' — blocks approval'
                          : ' — advisory'}
                      </h3>
                      <p className="text-sm text-text-muted">
                        {CONFLICT_CLASS_EXPLANATIONS[group.conflictClass]}
                      </p>
                      <ul className="flex flex-col gap-sp-1">
                        {group.items.map((conflict, index) => (
                          <li
                            className="text-sm text-text"
                            key={`${conflict.code}-${conflict.subject ?? ''}-${String(index)}`}
                          >
                            <span className="font-medium">{conflict.code}</span>
                            {conflict.subject === null ? '' : ` (${conflict.subject})`} —{' '}
                            {conflict.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </section>
            )}

            {/* ── hard-rule findings ──────────────────────────────────────── */}
            {data.violations.length === 0 ? null : (
              <section
                aria-labelledby="violations-heading"
                className="flex flex-col gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-4"
              >
                <h2 className="text-lg font-semibold text-text" id="violations-heading">
                  Hard-rule findings
                </h2>
                <p className="text-sm text-text-muted">
                  Measured independently of the solver. A rule the checker could not evaluate blocks
                  just as a broken one does.
                </p>
                <ul className="flex flex-col gap-sp-1" data-testid="build-violations">
                  {data.violations.map((violation, index) => (
                    <li className="text-sm text-text" key={`${violation.ruleKey}-${String(index)}`}>
                      <span className="font-medium">{violation.ruleKey}</span> ({violation.finding})
                      — {violation.explanation}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── refusals the surface must state plainly ─────────────────── */}
            {movedTo === null ? null : (
              <p
                className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
                data-testid="build-state-moved"
                role="alert"
              >
                This build moved while you were looking at it — it is now “
                {STATE_LABELS[movedTo as keyof typeof STATE_LABELS] ?? movedTo}”. Nothing was
                changed.{' '}
                <button
                  className={SECONDARY_BUTTON_CLASS}
                  data-testid="build-refetch"
                  onClick={() => {
                    setMovedTo(null);
                    void detail.refetch();
                  }}
                  type="button"
                >
                  Reload it
                </button>
              </p>
            )}
            {sourceMoved ? (
              <p
                className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
                data-testid="build-source-moved"
                role="alert"
              >
                The draft this build was based on has changed since the build ran. Nothing was
                applied — review the change and decide again.
              </p>
            ) : null}
            {message === null ? null : (
              <p
                className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
                data-testid="build-error"
                role="alert"
              >
                {message}
              </p>
            )}
            {retriedRunId === null ? null : (
              <p className="text-text" data-testid="build-retried" role="status">
                A new build was created to retry this one. It carries the same pinned input, and
                this build is kept as the record of what happened.
              </p>
            )}
            {appliedVersionId === null ? null : (
              <p className="text-text" data-testid="build-applied" role="status">
                The candidate is now draft version {appliedVersionId}. Review and publish it through
                the usual path.
              </p>
            )}

            {/* ── actions ─────────────────────────────────────────────────── */}
            <section aria-labelledby="actions-heading" className="flex flex-col gap-sp-2">
              <h2 className="text-lg font-semibold text-text" id="actions-heading">
                What you can do
              </h2>
              <p className={narrow ? 'flex flex-col gap-sp-2' : 'flex flex-wrap gap-sp-2'}>
                {run.state === 'draft_configuration' ? (
                  <button
                    className={PRIMARY_BUTTON_CLASS}
                    data-testid="build-submit"
                    disabled={move.isPending}
                    onClick={() => move.mutate({ action: 'submit', expected: run.state })}
                    type="button"
                  >
                    Submit for validation
                  </button>
                ) : null}
                {run.state === 'queued' ? (
                  <button
                    className={PRIMARY_BUTTON_CLASS}
                    data-testid="build-run"
                    disabled={start.isPending}
                    onClick={() => start.mutate()}
                    type="button"
                  >
                    Run it now
                  </button>
                ) : null}
                {run.state === 'queued' || run.state === 'running' ? (
                  <button
                    className={SECONDARY_BUTTON_CLASS}
                    data-testid="build-cancel-open"
                    onClick={() => {
                      // Local state only. Nothing is cancelled, nothing is fetched.
                      setIsConfirmingCancel(true);
                    }}
                    type="button"
                  >
                    Cancel this build
                  </button>
                ) : null}
                {run.state === 'completed' || run.state === 'completed_with_unmet_preferences' ? (
                  <button
                    className={PRIMARY_BUTTON_CLASS}
                    data-testid="build-review"
                    disabled={move.isPending}
                    onClick={() => move.mutate({ action: 'review', expected: run.state })}
                    type="button"
                  >
                    I have reviewed the findings
                  </button>
                ) : null}
                {run.state === 'reviewed' ? (
                  <button
                    className={PRIMARY_BUTTON_CLASS}
                    data-testid="build-approve"
                    disabled={move.isPending}
                    onClick={() => move.mutate({ action: 'approve', expected: run.state })}
                    type="button"
                  >
                    Approve
                  </button>
                ) : null}
                {run.state === 'reviewed' ? (
                  <button
                    className={SECONDARY_BUTTON_CLASS}
                    data-testid="build-extend"
                    disabled={move.isPending}
                    onClick={() => move.mutate({ action: 'extend', expected: run.state })}
                    type="button"
                  >
                    Run a further stage over this result
                  </button>
                ) : null}
                {run.state === 'progressively_extended' ? (
                  <button
                    className={SECONDARY_BUTTON_CLASS}
                    data-testid="build-stage-complete"
                    disabled={move.isPending}
                    onClick={() => move.mutate({ action: 'stage-complete', expected: run.state })}
                    type="button"
                  >
                    The stage is complete
                  </button>
                ) : null}
                {/* FAD-45(2): retry from the states where a retry is meaningful.
                    `infeasible` is included deliberately — report 21 draws
                    "relax constraints and retry" from it, and although the edge
                    is not in-place (SPEC-04 §2), re-posing the problem after
                    changing the inputs is exactly what a scheduler does next. */}
                {RETRYABLE_STATES.has(run.state) ? (
                  <button
                    className={PRIMARY_BUTTON_CLASS}
                    data-testid="build-retry"
                    disabled={retry.isPending || run.retryAttempt >= run.retryLimit}
                    onClick={() => retry.mutate()}
                    type="button"
                  >
                    Retry as a new build
                  </button>
                ) : null}
                {run.state === 'approved' ? (
                  /* DISABLED, not hidden, and the banner above says why — the
                     `build-retries-exhausted` rationale applied to staleness: a
                     control that vanishes teaches nothing, and a scheduler who
                     cannot find the button assumes the screen is broken.
                     The server refuses it regardless (STALE_BUILD_INPUTS); this
                     is the courtesy, never the control. */
                  <button
                    className={PRIMARY_BUTTON_CLASS}
                    data-testid="build-apply-open"
                    disabled={data.staleness.stale}
                    onClick={() => {
                      // Local state only. Nothing is applied, nothing is fetched.
                      setIsConfirmingApply(true);
                    }}
                    type="button"
                  >
                    Select this candidate
                  </button>
                ) : null}
              </p>

              {isConfirmingCancel ? (
                <div
                  className="flex flex-col gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-4"
                  data-testid="build-cancel-confirm"
                >
                  <p className="text-text">
                    {run.state === 'running'
                      ? 'The solve will be asked to stop. It moves to “cancelled” when it actually stops — not when you press this.'
                      : 'This build has not started. Cancelling it now is immediate.'}
                  </p>
                  <p className="flex flex-wrap gap-sp-2">
                    <button
                      className={PRIMARY_BUTTON_CLASS}
                      data-testid="build-cancel-confirm-button"
                      disabled={move.isPending}
                      onClick={() => move.mutate({ action: 'cancel', expected: run.state })}
                      type="button"
                    >
                      Cancel the build
                    </button>
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      onClick={() => setIsConfirmingCancel(false)}
                      type="button"
                    >
                      Keep it running
                    </button>
                  </p>
                </div>
              ) : null}

              {isConfirmingApply ? (
                <div
                  className="flex flex-col gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-4"
                  data-testid="build-apply-confirm"
                >
                  <p className="text-text">
                    This writes the candidate into a NEW draft version. The draft this build was
                    based on is not changed, and nothing is published.
                  </p>
                  <p className="flex flex-wrap gap-sp-2">
                    <button
                      className={PRIMARY_BUTTON_CLASS}
                      data-testid="build-apply-confirm-button"
                      disabled={apply.isPending}
                      onClick={() => apply.mutate(data.sourceDigest)}
                      type="button"
                    >
                      Write it to a new draft
                    </button>
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      onClick={() => setIsConfirmingApply(false)}
                      type="button"
                    >
                      Not yet
                    </button>
                  </p>
                </div>
              ) : null}
            </section>

            {/* ── the timeline, including recovery ────────────────────────── */}
            <section aria-labelledby="timeline-heading" className="flex flex-col gap-sp-2">
              <h2 className="text-lg font-semibold text-text" id="timeline-heading">
                What has happened to this build
              </h2>
              <ol className="flex flex-col gap-sp-1" data-testid="build-timeline">
                {data.events.map((event, index) => (
                  <li
                    className="text-sm text-text-muted"
                    key={`${event.occurredAt}-${String(index)}`}
                  >
                    {event.kind === 'result_refused' ? (
                      <span className="text-text" data-testid="build-fenced-event">
                        A result from a superseded claim (epoch {event.claimEpoch}) was refused; the
                        current claim is epoch {event.currentClaimEpoch}.
                      </span>
                    ) : event.kind === 'heartbeat_reaped' ? (
                      <span className="text-text" data-testid="build-reaped-event">
                        The worker stopped reporting and the build was recovered as failed.
                      </span>
                    ) : (
                      <>
                        {event.fromState === null
                          ? 'Created'
                          : `${STATE_LABELS[event.fromState]} → ${
                              event.toState === null ? '' : STATE_LABELS[event.toState]
                            }`}
                        {event.reason === null ? '' : ` (${event.reason})`}
                      </>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </SurfaceState>
    </BuildsLayout>
  );
}
