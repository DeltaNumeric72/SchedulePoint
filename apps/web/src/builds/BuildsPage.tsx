import type { BuildRunSummary } from '@schedulepoint/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import { ValidationError } from '../api/catalogue.js';
import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import {
  CONTROL_CLASS,
  Field,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  useFieldIds,
  ValidationSummary,
  type FieldProblem,
} from '../components/Form.js';
import { isPermissionDenied, SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { BuildsLayout, REPRODUCIBILITY_LABELS, STATE_LABELS } from './BuildsLayout.js';
import { createConfiguration, createRun, fetchConfigurations, fetchRuns } from './api.js';

/**
 * The period's builds: what has been configured, what has run, and what a
 * scheduler may do next (OPUS-M4-003).
 *
 * ## I-13, twice
 *
 * "New configuration" and "Start a build" are both local state and issue ZERO
 * requests. Nothing is created until a completed form is validated and saved,
 * and both budgets say so in `budgets.json` — where the number can never be
 * raised without the invariant changing first.
 *
 * ## Comparison is opt-in and needs two
 *
 * D-4c is a read-only projection over completed candidates. The control refuses
 * to navigate with fewer than two selected rather than silently comparing a
 * candidate with itself, because "these are identical" is a true statement that
 * answers nothing.
 */

function problemFor(problems: readonly FieldProblem[], field: string): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}

export function BuildsPage(): JSX.Element {
  const scope = useGroupScope();
  const { periodId } = useParams({ strict: false }) as { periodId?: string };
  const period = periodId ?? '';
  const queryClient = useQueryClient();
  const narrow = useNarrowViewport();

  const configurations = useQuery({
    queryKey: ['build-configurations', scope.organizationId, scope.groupId, period],
    queryFn: async () => fetchConfigurations(scope, period),
    enabled: period !== '',
    retry: false,
  });

  const runs = useQuery({
    queryKey: ['build-runs', scope.organizationId, scope.groupId, period],
    queryFn: async () => fetchRuns(scope, period),
    enabled: period !== '',
    retry: false,
  });

  /* I-13: opening either form is local state and issues no request. */
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [isLaunching, setIsLaunching] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);

  const [name, setName] = useState('');
  const [maxSeconds, setMaxSeconds] = useState('10');
  /* Opt-IN, defaulting off: the non-deterministic portfolio stays the default
   * (doc 35 §6f ruling (3)). A default-on reproducible mode would pay the
   * measured cost on every build for a property most builds do not need. */
  const [deterministic, setDeterministic] = useState(false);
  const [label, setLabel] = useState('');
  const [sourceVersionId, setSourceVersionId] = useState('');

  const configurationFields = useFieldIds('build-configuration', ['name', 'maxTimeSeconds']);
  const launchFields = useFieldIds('build-launch', ['candidateLabel', 'sourceVersionId']);

  const saveConfiguration = useMutation({
    mutationFn: async () =>
      createConfiguration(scope, {
        periodId: period,
        name,
        maxTimeSeconds: Number(maxSeconds),
        /* The FULL SPEC-04 §4 amended set, or none of it. A partial pinning —
         * `interleaveSearch` without `maxDeterministicTime`, say — computes to
         * `best-effort` server-side, so offering half the conditions would let a
         * scheduler tick a box and get nothing. */
        ...(deterministic
          ? {
              interleaveSearch: true,
              maxDeterministicTime: Number(maxSeconds),
              numSearchWorkers: 1,
            }
          : {}),
      }),
    onSuccess: () => {
      setIsConfiguring(false);
      setName('');
      setDeterministic(false);
      setProblems([]);
      setMessage(null);
      /* PO-DEC-18: the SERVER is the authority. The list is re-read rather than
       * patched from the response. */
      void queryClient.invalidateQueries({ queryKey: ['build-configurations'] });
    },
    onError: (error: unknown) => {
      if (error instanceof ValidationError) {
        setProblems(error.problems);
        return;
      }
      setMessage(
        isPermissionDenied(error)
          ? 'You do not have permission to configure builds for this group.'
          : (error as Error).message,
      );
    },
  });

  const launch = useMutation({
    mutationFn: async (configurationId: string) =>
      createRun(scope, {
        configurationId,
        sourceVersionId,
        candidateLabel: label,
        /* The key is minted ONCE per form opening, not per click: a second click
         * must not become a second build (D-17). */
        idempotencyKey: launchKey,
      }),
    onSuccess: () => {
      setIsLaunching(null);
      setLabel('');
      setProblems([]);
      setMessage(null);
      void queryClient.invalidateQueries({ queryKey: ['build-runs'] });
    },
    onError: (error: unknown) => {
      if (error instanceof ValidationError) {
        setProblems(error.problems);
        return;
      }
      setMessage(
        isPermissionDenied(error)
          ? 'You do not have permission to start builds for this group.'
          : 'A build of this configuration is already in flight for this period. Let it finish, or cancel it first.',
      );
    },
  });

  /* One key per form opening. Regenerated when the form opens, never per click. */
  const [launchKey, setLaunchKey] = useState('');

  const runList: readonly BuildRunSummary[] = runs.data?.runs ?? [];

  return (
    <BuildsLayout
      title="Builds"
      description="Configure, run, review and select an automatically generated schedule."
      periodId={period === '' ? null : period}
    >
      {message === null ? null : (
        <p
          className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
          role="alert"
          data-testid="builds-message"
        >
          {message}
        </p>
      )}

      <section aria-labelledby="configurations-heading" className="flex min-w-0 flex-col gap-sp-3">
        <h2 className="text-lg font-semibold text-text" id="configurations-heading">
          Build configurations
        </h2>

        <SurfaceState
          isLoading={configurations.isPending}
          error={configurations.error}
          isEmpty={(configurations.data?.configurations.length ?? 0) === 0}
          emptyMessage="This period has no build configurations yet. Create one to describe how a build should run."
          label="the build configurations"
        >
          <ul className="flex flex-col gap-sp-2" data-testid="build-configurations-list">
            {(configurations.data?.configurations ?? []).map((configuration) => (
              <li
                className="flex flex-wrap items-center justify-between gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-3"
                data-testid={`build-configuration-${configuration.id}`}
                key={configuration.id}
              >
                <span className="min-w-0 text-text">
                  <span className="font-medium">{configuration.name}</span>
                  <span
                    className="ml-sp-2 text-sm text-text-muted"
                    data-testid={`build-configuration-mode-${configuration.reproducibilityMode}`}
                  >
                    {configuration.maxTimeSeconds}s limit ·{' '}
                    {REPRODUCIBILITY_LABELS[configuration.reproducibilityMode] ??
                      configuration.reproducibilityMode}{' '}
                    · retries up to {configuration.retryLimit}
                  </span>
                </span>
                <button
                  className={SECONDARY_BUTTON_CLASS}
                  data-testid={`build-launch-open-${configuration.id}`}
                  onClick={() => {
                    // I-13: local state only. Nothing is created, nothing is fetched.
                    setProblems([]);
                    setMessage(null);
                    setLaunchKey(
                      `ui.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`,
                    );
                    setIsLaunching(configuration.id);
                  }}
                  type="button"
                >
                  Start a build
                </button>
              </li>
            ))}
          </ul>
        </SurfaceState>

        {isConfiguring ? (
          <form
            className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
            data-testid="build-configuration-form"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setProblems([]);
              saveConfiguration.mutate();
            }}
          >
            <ValidationSummary
              fieldIds={configurationFields}
              formName="build-configuration"
              problems={problems}
            />
            <Field
              help="What this way of building is called. Candidates are compared by configuration."
              id={configurationFields.name}
              label="Configuration name"
              problem={problemFor(problems, 'name')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  onChange={(event) => setName(event.target.value)}
                  type="text"
                  value={name}
                />
              )}
            </Field>
            <Field
              help="The solver's own time limit, in seconds. A build that reaches it is reported as timed out, never as infeasible."
              id={configurationFields.maxTimeSeconds}
              label="Time limit (seconds)"
              problem={problemFor(problems, 'maxTimeSeconds')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  inputMode="numeric"
                  onChange={(event) => setMaxSeconds(event.target.value)}
                  type="text"
                  value={maxSeconds}
                />
              )}
            </Field>
            {/* ── deterministic mode, opt-in, with its cost disclosed ──────
                doc 35 §6f ruling (3): opt-in per build configuration, pinning
                the FULL SPEC-04 §4 amended set. The checkbox does NOT set
                `reproducibilityMode` — that is COMPUTED server-side from the
                parameters, and a client-settable flag is exactly the claim the
                amendment exists to stop (five runs, one seed, eight workers,
                five different schedules). It sets the CONDITIONS: the
                deterministic portfolio on, a deterministic time limit pinned,
                and a single search worker. */}
            <fieldset className="flex flex-col gap-sp-2 border-0 p-0">
              <legend className="text-sm font-medium text-text">Reproducibility</legend>
              <label className="flex items-start gap-sp-2 text-text">
                <input
                  checked={deterministic}
                  className="mt-sp-1 min-h-target min-w-target"
                  data-testid="build-configuration-deterministic"
                  onChange={(event) => setDeterministic(event.target.checked)}
                  type="checkbox"
                />
                <span>Deterministic mode — the same problem produces the same schedule</span>
              </label>
              {/* REPAIR F-04 (FAD-46). This previously quoted EV-M0-SPC H-7's
                  TOY-instance figures — "12× slower on a small instance and
                  faster on a hard one" — which is a measurement of a different
                  program on a different problem, presented to a scheduler as
                  though it described this build. THIS packet measured the cost on
                  the E1 corpus (EV-M4-004 §5) and that is what is disclosed.

                  The honest shape of that measurement: thirteen of fourteen
                  classes solve in milliseconds, so their ≈1× is measuring worker
                  STARTUP, not search. One class carries an objective large enough
                  to search, and it cost 10×. H-7's other half — the deterministic
                  portfolio running FASTER on a hard instance — did NOT reproduce,
                  because the corpus has no instance that hard. That is a gap in
                  the corpus, and claiming the speed-up anyway would be quoting a
                  benefit this system has never observed. */}
              <p className="text-sm text-text-muted" data-testid="build-deterministic-cost">
                Deterministic mode replaces the parallel search with a single reproducible one and
                stops on a machine-independent budget rather than a clock. Measured on this system’s
                own build classes: about the same wall clock on classes whose solve is dominated by
                worker startup, and about 10× slower on the one class with an objective large enough
                to search — where it also returned a feasible schedule instead of proving an optimal
                one. No speed target is set, and no benchmark band exists until M6.
              </p>
            </fieldset>
            <p className="flex flex-wrap gap-sp-2">
              <button
                className={PRIMARY_BUTTON_CLASS}
                data-testid="build-configuration-save"
                disabled={saveConfiguration.isPending}
                type="submit"
              >
                Save configuration
              </button>
              <button
                className={SECONDARY_BUTTON_CLASS}
                onClick={() => setIsConfiguring(false)}
                type="button"
              >
                Cancel
              </button>
            </p>
          </form>
        ) : (
          <p>
            <button
              className={PRIMARY_BUTTON_CLASS}
              data-testid="build-configuration-new"
              onClick={() => {
                // I-13: local state only. Nothing is created, nothing is fetched.
                setProblems([]);
                setMessage(null);
                setIsConfiguring(true);
              }}
              type="button"
            >
              New configuration
            </button>
          </p>
        )}

        {isLaunching === null ? null : (
          <form
            className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
            data-testid="build-launch-form"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setProblems([]);
              launch.mutate(isLaunching);
            }}
          >
            <ValidationSummary
              fieldIds={launchFields}
              formName="build-launch"
              problems={problems}
            />
            <Field
              help="How this candidate is named when you compare it with another."
              id={launchFields.candidateLabel}
              label="Candidate label"
              problem={problemFor(problems, 'candidateLabel')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  onChange={(event) => setLabel(event.target.value)}
                  type="text"
                  value={label}
                />
              )}
            </Field>
            <Field
              help="The draft this build is posed against. Its pinned assignments become fixed inputs; it is never edited by the build."
              id={launchFields.sourceVersionId}
              label="Source draft version"
              problem={problemFor(problems, 'sourceVersionId')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  onChange={(event) => setSourceVersionId(event.target.value)}
                  type="text"
                  value={sourceVersionId}
                />
              )}
            </Field>
            <p className="flex flex-wrap gap-sp-2">
              <button
                className={PRIMARY_BUTTON_CLASS}
                data-testid="build-launch-save"
                disabled={launch.isPending}
                type="submit"
              >
                Create the build
              </button>
              <button
                className={SECONDARY_BUTTON_CLASS}
                onClick={() => setIsLaunching(null)}
                type="button"
              >
                Cancel
              </button>
            </p>
          </form>
        )}
      </section>

      <section aria-labelledby="runs-heading" className="flex min-w-0 flex-col gap-sp-3">
        <h2 className="text-lg font-semibold text-text" id="runs-heading">
          Builds
        </h2>

        <SurfaceState
          isLoading={runs.isPending}
          error={runs.error}
          isEmpty={runList.length === 0}
          emptyMessage="No builds have been created for this period yet."
          label="the builds for this period"
        >
          {narrow ? (
            <ul className="flex flex-col gap-sp-2" data-testid="build-runs-list">
              {runList.map((run) => (
                <li
                  className="flex flex-col gap-sp-1 rounded-panel border border-border bg-surface-raised p-sp-3"
                  data-testid={`build-run-${run.id}`}
                  key={run.id}
                >
                  <span className="font-medium text-text">{run.candidateLabel}</span>
                  <span className="text-sm text-text-muted">{STATE_LABELS[run.state]}</span>
                  <Link
                    className="text-accent underline"
                    data-testid={`build-run-open-${run.id}`}
                    params={{
                      organizationId: scope.organizationId,
                      groupId: scope.groupId,
                      buildRunId: run.id,
                    }}
                    to="/organizations/$organizationId/groups/$groupId/builds/runs/$buildRunId"
                  >
                    Open this build
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="min-w-0 overflow-x-auto" tabIndex={0}>
              <table className="w-full border-collapse text-left" data-testid="build-runs-table">
                <caption className="sr-only">
                  Builds for this period, with their state and configuration
                </caption>
                <thead>
                  <tr>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Compare
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Candidate
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Configuration
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      State
                    </th>
                    <th className="border-b border-border p-sp-2" scope="col">
                      Open
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runList.map((run) => (
                    <tr data-testid={`build-run-${run.id}`} key={run.id}>
                      <td className="border-b border-border p-sp-2">
                        <input
                          aria-label={`Compare the candidate ${run.candidateLabel}`}
                          checked={selected.includes(run.id)}
                          data-testid={`build-compare-${run.id}`}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, run.id]
                                : current.filter((id) => id !== run.id),
                            )
                          }
                          type="checkbox"
                        />
                      </td>
                      <td className="border-b border-border p-sp-2 text-text">
                        {run.candidateLabel}
                      </td>
                      <td className="border-b border-border p-sp-2 text-text-muted">
                        {run.configurationName}
                      </td>
                      <td className="border-b border-border p-sp-2 text-text">
                        {STATE_LABELS[run.state]}
                      </td>
                      <td className="border-b border-border p-sp-2">
                        <Link
                          className="text-accent underline"
                          data-testid={`build-run-open-${run.id}`}
                          params={{
                            organizationId: scope.organizationId,
                            groupId: scope.groupId,
                            buildRunId: run.id,
                          }}
                          to="/organizations/$organizationId/groups/$groupId/builds/runs/$buildRunId"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SurfaceState>

        {selected.length >= 2 ? (
          <p>
            <Link
              className={SECONDARY_BUTTON_CLASS}
              data-testid="build-compare-open"
              params={{ organizationId: scope.organizationId, groupId: scope.groupId }}
              search={{ runIds: selected.join(',') }}
              to="/organizations/$organizationId/groups/$groupId/builds/comparison"
            >
              Compare {selected.length} candidates
            </Link>
          </p>
        ) : (
          <p className="text-sm text-text-muted" data-testid="build-compare-hint">
            Select two or more candidates to compare them.
          </p>
        )}
      </section>
    </BuildsLayout>
  );
}
