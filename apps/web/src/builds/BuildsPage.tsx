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
import { BuildsLayout, STATE_LABELS } from './BuildsLayout.js';
import {
  createConfiguration,
  createRun,
  fetchConfigurations,
  fetchRuns,
} from './api.js';

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
      }),
    onSuccess: () => {
      setIsConfiguring(false);
      setName('');
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
        <p className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text" role="alert" data-testid="builds-message">
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
                  <span className="ml-sp-2 text-sm text-text-muted">
                    {configuration.maxTimeSeconds}s limit · {configuration.reproducibilityMode} ·
                    retries up to {configuration.retryLimit}
                  </span>
                </span>
                <button
                  className={SECONDARY_BUTTON_CLASS}
                  data-testid={`build-launch-open-${configuration.id}`}
                  onClick={() => {
                    // I-13: local state only. Nothing is created, nothing is fetched.
                    setProblems([]);
                    setMessage(null);
                    setLaunchKey(`ui.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`);
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
            <ValidationSummary fieldIds={launchFields} formName="build-launch" problems={problems} />
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
                      <td className="border-b border-border p-sp-2 text-text">{run.candidateLabel}</td>
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
