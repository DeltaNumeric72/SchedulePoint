import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import { ValidationError, fetchShiftTypes } from '../api/catalogue.js';
import {
  StaleEditError,
  cloneVersion,
  createDraftVersion,
  createPeriod,
  fetchPeriods,
  fetchRequirements,
  fetchVersions,
  setRequirement,
} from './api.js';
import { useGroupScope } from '../catalogue/CatalogueLayout.js';
import {
  CONTROL_CLASS,
  Field,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  ValidationSummary,
  useFieldIds,
  type FieldProblem,
} from '../components/Form.js';
import { SurfaceState } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { ScheduleLayout } from './ScheduleLayout.js';

/**
 * Period administration, demand authoring and draft management (OPUS-M3-004).
 *
 * ## I-13 everywhere, and it is measured
 *
 * > "No control labelled Add, New, or Create may persist anything before a
 * > completed form, validation, and an explicit Save."
 *
 * `New period` and `Add requirement` toggle local state and issue **zero**
 * requests — budgeted at 0 in `scripts/gates/request-budget/budgets.json`, where
 * the number can never be raised without the invariant changing first. The one
 * control on this page that is deliberately NOT a form is `New draft`: creating
 * an empty draft version has no fields to complete, so it is a single explicit
 * action with a confirmation step rather than a click that writes on hover.
 *
 * ## The requirement editor carries a compare-and-set
 *
 * The server upserts a requirement on (period, date, shift type). Without a
 * revision token a second author's number would silently replace a first's, so
 * every Save sends the revision the form was opened with and a `StaleEditError`
 * renders an explicit refetch prompt — never a silent retry (PO-DEC-18,
 * SP-E §1.4).
 */

export function PeriodsPage(): JSX.Element {
  return (
    <ScheduleLayout
      title="Periods and drafts"
      description="A period is the planning window. A draft version is the schedule being authored inside it; only a draft can be edited."
    >
      <PeriodsPanel />
    </ScheduleLayout>
  );
}

function PeriodsPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const narrow = useNarrowViewport();
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);

  const periods = useQuery({
    queryKey: ['schedule-periods', scope.organizationId, scope.groupId],
    queryFn: () => fetchPeriods(scope),
    retry: false,
  });

  const list = periods.data?.periods ?? [];

  return (
    <div className="flex flex-col gap-sp-5">
      <section aria-labelledby="periods-heading" className="flex flex-col gap-sp-3">
        <h2 className="text-lg font-semibold text-text" id="periods-heading">
          Periods
        </h2>

        <NewPeriodForm
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['schedule-periods'] });
          }}
        />

        <SurfaceState
          isLoading={periods.isPending}
          error={periods.error}
          isEmpty={list.length === 0}
          emptyMessage="No planning periods have been created for this group yet."
          label="the schedule periods"
        >
          {narrow ? (
            <ul className="flex flex-col gap-sp-3" data-testid="periods-list">
              {list.map((period) => (
                <li
                  className="rounded-panel border border-border bg-surface-raised p-sp-3"
                  data-testid={`period-row-${period.id}`}
                  key={period.id}
                >
                  <h3 className="font-semibold text-text">{period.name}</h3>
                  <dl className="mt-sp-2 flex flex-col gap-sp-1 text-sm">
                    <div className="flex gap-sp-2">
                      <dt className="text-text-muted">Window</dt>
                      <dd className="text-text">
                        {period.startDate} to {period.endDate}
                      </dd>
                    </div>
                    <div className="flex gap-sp-2">
                      <dt className="text-text-muted">Status</dt>
                      <dd className="text-text">{period.status}</dd>
                    </div>
                  </dl>
                  <p className="mt-sp-3">
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      data-testid={`period-open-${period.id}`}
                      onClick={() => setSelectedPeriodId(period.id)}
                      type="button"
                    >
                      Open<span className="sr-only"> period {period.name}</span>
                    </button>
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <table className="w-full border-collapse text-left" data-testid="periods-table">
              <caption className="sr-only">Schedule periods for this group</caption>
              <thead>
                <tr>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Name
                  </th>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Starts
                  </th>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Ends
                  </th>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Status
                  </th>
                  <th className="border-b border-border p-sp-2" scope="col">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((period) => (
                  <tr data-testid={`period-row-${period.id}`} key={period.id}>
                    <th className="border-b border-border p-sp-2 font-normal" scope="row">
                      {period.name}
                    </th>
                    <td className="border-b border-border p-sp-2">{period.startDate}</td>
                    <td className="border-b border-border p-sp-2">{period.endDate}</td>
                    <td className="border-b border-border p-sp-2">{period.status}</td>
                    <td className="border-b border-border p-sp-2">
                      <button
                        className={SECONDARY_BUTTON_CLASS}
                        data-testid={`period-open-${period.id}`}
                        onClick={() => setSelectedPeriodId(period.id)}
                        type="button"
                      >
                        Open
                        {/* The accessible name names the PERIOD, so the button
                            makes sense read out of context (SP-HR-3). */}
                        <span className="sr-only"> period {period.name}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SurfaceState>
      </section>

      {selectedPeriodId === null ? null : (
        <>
          <VersionsPanel periodId={selectedPeriodId} />
          <RequirementsPanel periodId={selectedPeriodId} />
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * New period — I-13's centrepiece on this page
 * ──────────────────────────────────────────────────────────────────────────── */

function NewPeriodForm({ onSaved }: { onSaved: () => void }): JSX.Element {
  const scope = useGroupScope();
  const fieldIds = useFieldIds('period', ['name', 'startDate', 'endDate'] as const);

  /** I-13: opening the form is local state and issues no request. */
  const [isAuthoring, setIsAuthoring] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const save = useMutation({
    mutationFn: () => createPeriod(scope, { name, startDate, endDate }),
    onSuccess: () => {
      setProblems([]);
      setIsAuthoring(false);
      setName('');
      setStartDate('');
      setEndDate('');
      onSaved();
    },
    onError: (error: unknown) =>
      setProblems(error instanceof ValidationError ? error.problems : []),
  });

  if (!isAuthoring) {
    return (
      <p>
        <button
          className={PRIMARY_BUTTON_CLASS}
          data-testid="periods-new"
          onClick={() => {
            // I-13: local state only. Nothing is created, nothing is fetched.
            setProblems([]);
            setIsAuthoring(true);
          }}
          type="button"
        >
          New period
        </button>
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
      data-testid="periods-form"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setProblems([]);
        save.mutate();
      }}
    >
      <ValidationSummary problems={problems} fieldIds={fieldIds} formName="period" />

      <Field
        id={fieldIds.name}
        label="Period name"
        help="How this planning window is referred to. It must be unique in the group."
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
        id={fieldIds.startDate}
        label="First day"
        help="YYYY-MM-DD. Periods in a group may not overlap."
        problem={problemFor(problems, 'startDate')}
      >
        {(attributes) => (
          <input
            {...attributes}
            className={CONTROL_CLASS}
            onChange={(event) => setStartDate(event.target.value)}
            placeholder="2028-01-02"
            type="text"
            value={startDate}
          />
        )}
      </Field>

      <Field
        id={fieldIds.endDate}
        label="Last day"
        help="YYYY-MM-DD, and the last day included in the period."
        problem={problemFor(problems, 'endDate')}
      >
        {(attributes) => (
          <input
            {...attributes}
            className={CONTROL_CLASS}
            onChange={(event) => setEndDate(event.target.value)}
            placeholder="2028-01-31"
            type="text"
            value={endDate}
          />
        )}
      </Field>

      <div className="flex flex-wrap gap-sp-3">
        <button className={PRIMARY_BUTTON_CLASS} data-testid="periods-save" type="submit">
          Save period
        </button>
        <button
          className={SECONDARY_BUTTON_CLASS}
          onClick={() => {
            setIsAuthoring(false);
            setProblems([]);
          }}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Versions
 * ──────────────────────────────────────────────────────────────────────────── */

function VersionsPanel({ periodId }: { periodId: string }): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  /** The two-step confirmation that stands in for a form on a fieldless action. */
  const [confirming, setConfirming] = useState<'new' | 'clone' | null>(null);
  const [cloneSource, setCloneSource] = useState<string>('');

  const versions = useQuery({
    queryKey: ['schedule-versions', scope.organizationId, scope.groupId, periodId],
    queryFn: () => fetchVersions(scope, periodId),
    retry: false,
  });

  const invalidate = (): void => {
    setConfirming(null);
    void queryClient.invalidateQueries({ queryKey: ['schedule-versions'] });
  };

  const create = useMutation({
    mutationFn: () => createDraftVersion(scope, periodId),
    onSuccess: invalidate,
  });
  const clone = useMutation({
    mutationFn: () => cloneVersion(scope, cloneSource),
    onSuccess: invalidate,
  });

  const list = versions.data?.versions ?? [];

  return (
    <section aria-labelledby="versions-heading" className="flex flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="versions-heading">
        Draft versions
      </h2>
      <p className="text-sm text-text-muted">
        A published version is never edited. To amend one, clone it into a new draft and publish
        forward.
      </p>

      <div className="flex flex-wrap gap-sp-3">
        <button
          className={PRIMARY_BUTTON_CLASS}
          data-testid="versions-new"
          onClick={() => setConfirming('new')}
          type="button"
        >
          New draft
        </button>
        <button
          className={SECONDARY_BUTTON_CLASS}
          data-testid="versions-clone"
          disabled={list.length === 0}
          onClick={() => {
            setCloneSource(list[list.length - 1]?.id ?? '');
            setConfirming('clone');
          }}
          type="button"
        >
          Clone a version
        </button>
      </div>

      {confirming === null ? null : (
        <div
          className="rounded-panel border border-border bg-surface-raised p-sp-4"
          data-testid="versions-confirm"
        >
          <p className="text-text">
            {confirming === 'new'
              ? 'Create an empty draft version in this period?'
              : 'Copy the selected version into a new draft? The source is not changed.'}
          </p>
          {confirming === 'clone' ? (
            <p className="mt-sp-3">
              <label className="font-medium text-text" htmlFor="clone-source">
                Version to copy
              </label>
              <select
                className={`${CONTROL_CLASS} mt-sp-1 block`}
                data-testid="versions-clone-source"
                id="clone-source"
                onChange={(event) => setCloneSource(event.target.value)}
                value={cloneSource}
              >
                {list.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.versionNumber === null
                      ? `Draft (${version.state})`
                      : `Version ${String(version.versionNumber)} (${version.state})`}
                  </option>
                ))}
              </select>
            </p>
          ) : null}
          <div className="mt-sp-3 flex flex-wrap gap-sp-3">
            <button
              className={PRIMARY_BUTTON_CLASS}
              data-testid="versions-confirm-save"
              onClick={() => (confirming === 'new' ? create.mutate() : clone.mutate())}
              type="button"
            >
              {confirming === 'new' ? 'Create draft' : 'Create the copy'}
            </button>
            <button
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => setConfirming(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <SurfaceState
        isLoading={versions.isPending}
        error={versions.error}
        isEmpty={list.length === 0}
        emptyMessage="This period has no versions yet. Create a draft to start authoring."
        label="the schedule versions"
      >
        <ul className="flex flex-col gap-sp-2" data-testid="versions-list">
          {list.map((version) => (
            <li
              className="flex flex-wrap items-center gap-sp-3 rounded-panel border border-border bg-surface-raised p-sp-3"
              data-testid={`version-row-${version.id}`}
              key={version.id}
            >
              <span className="text-text">
                {version.versionNumber === null
                  ? 'Unpublished draft'
                  : `Version ${String(version.versionNumber)}`}
              </span>
              {/* State is text, never colour alone (SPEC-14). */}
              <span className="text-sm text-text-muted">{version.state}</span>
              {version.isCurrent ? (
                <span className="text-sm font-medium text-text">Current</span>
              ) : null}
              <a
                className="inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text"
                data-testid={`version-open-${version.id}`}
                href={`/organizations/${scope.organizationId}/groups/${scope.groupId}/schedule/versions/${version.id}`}
              >
                {version.isEditable ? 'Edit' : 'View'}
                <span className="sr-only">
                  {' '}
                  version {version.versionNumber === null ? 'draft' : String(version.versionNumber)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </SurfaceState>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Requirements — period-scoped demand
 * ──────────────────────────────────────────────────────────────────────────── */

function RequirementsPanel({ periodId }: { periodId: string }): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('requirement', ['date', 'shiftTypeId', 'requiredCount'] as const);

  const [isAuthoring, setIsAuthoring] = useState(false);
  const [date, setDate] = useState('');
  const [shiftTypeId, setShiftTypeId] = useState('');
  const [requiredCount, setRequiredCount] = useState('1');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

  const requirements = useQuery({
    queryKey: ['schedule-requirements', scope.organizationId, scope.groupId, periodId],
    queryFn: () => fetchRequirements(scope, periodId),
    retry: false,
  });
  const shiftTypes = useQuery({
    queryKey: ['shift-types', scope.organizationId, scope.groupId],
    queryFn: () => fetchShiftTypes(scope),
    retry: false,
  });

  const list = requirements.data?.requirements ?? [];

  /**
   * The revision the Save will send.
   *
   * Read from the LIST the form was opened against, so it is the token for the
   * state the author actually saw. A token computed at submit time would always
   * match and the compare-and-set would be decorative.
   */
  const revisionFor = (forDate: string, forShiftType: string): string =>
    list.find((row) => row.date === forDate && row.shiftTypeId === forShiftType)?.revision ??
    requirements.data?.absentRequirementRevision ??
    '';

  const save = useMutation({
    mutationFn: () =>
      setRequirement(scope, periodId, {
        date,
        shiftTypeId,
        requiredCount: Number(requiredCount),
        expectedRevision: revisionFor(date, shiftTypeId),
      }),
    onSuccess: () => {
      setProblems([]);
      setStaleNotice(null);
      setIsAuthoring(false);
      void queryClient.invalidateQueries({ queryKey: ['schedule-requirements'] });
    },
    onError: (error: unknown) => {
      if (error instanceof StaleEditError) {
        // Never merged, never retried silently (PO-DEC-18).
        setStaleNotice(error.message);
        setProblems([]);
        void queryClient.invalidateQueries({ queryKey: ['schedule-requirements'] });
        return;
      }
      setProblems(error instanceof ValidationError ? error.problems : []);
      setStaleNotice(null);
    },
  });

  return (
    <section aria-labelledby="requirements-heading" className="flex flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="requirements-heading">
        Staffing requirements
      </h2>
      <p className="text-sm text-text-muted">
        How many people a date needs for a shift type. These are period instances, separate from the
        catalogue&rsquo;s per-weekday demand defaults.
      </p>

      {staleNotice === null ? null : (
        <div
          className="rounded-panel border border-danger bg-surface-raised p-sp-4"
          data-testid="requirements-stale"
          role="alert"
        >
          <p className="font-semibold text-danger">{staleNotice}</p>
          <p className="mt-sp-2 text-text">
            The list below has been re-read from the server. Open the form again to apply your
            change to the current value.
          </p>
        </div>
      )}

      {isAuthoring ? null : (
        <p>
          <button
            className={PRIMARY_BUTTON_CLASS}
            data-testid="requirements-new"
            onClick={() => {
              // I-13: local state only.
              setProblems([]);
              setStaleNotice(null);
              setIsAuthoring(true);
            }}
            type="button"
          >
            Add requirement
          </button>
        </p>
      )}

      {isAuthoring ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          data-testid="requirements-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            save.mutate();
          }}
        >
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="requirement" />

          <Field
            id={fieldIds.date}
            label="Date"
            help="YYYY-MM-DD, inside the period."
            problem={problemFor(problems, 'date')}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                onChange={(event) => setDate(event.target.value)}
                placeholder="2028-01-02"
                type="text"
                value={date}
              />
            )}
          </Field>

          <Field
            id={fieldIds.shiftTypeId}
            label="Shift type"
            problem={problemFor(problems, 'shiftTypeId')}
          >
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="requirements-shift-type"
                onChange={(event) => setShiftTypeId(event.target.value)}
                value={shiftTypeId}
              >
                <option value="">Choose a shift type</option>
                {(shiftTypes.data?.shiftTypes ?? []).map((shiftType) => (
                  <option key={shiftType.shiftTypeId} value={shiftType.shiftTypeId}>
                    {shiftType.code} — {shiftType.name}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            id={fieldIds.requiredCount}
            label="People required"
            problem={problemFor(problems, 'requiredCount')}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                inputMode="numeric"
                onChange={(event) => setRequiredCount(event.target.value)}
                type="text"
                value={requiredCount}
              />
            )}
          </Field>

          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} data-testid="requirements-save" type="submit">
              Save requirement
            </button>
            <button
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => {
                setIsAuthoring(false);
                setProblems([]);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <SurfaceState
        isLoading={requirements.isPending}
        error={requirements.error}
        isEmpty={list.length === 0}
        emptyMessage="No staffing requirements have been stated for this period yet."
        label="the staffing requirements"
      >
        <table className="w-full border-collapse text-left" data-testid="requirements-table">
          <caption className="sr-only">Staffing requirements for this period</caption>
          <thead>
            <tr>
              <th className="border-b border-border p-sp-2" scope="col">
                Date
              </th>
              <th className="border-b border-border p-sp-2" scope="col">
                Shift type
              </th>
              <th className="border-b border-border p-sp-2" scope="col">
                People required
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((requirement) => (
              <tr data-testid={`requirement-row-${requirement.id}`} key={requirement.id}>
                <th className="border-b border-border p-sp-2 font-normal" scope="row">
                  {requirement.date}
                </th>
                <td className="border-b border-border p-sp-2">
                  {(shiftTypes.data?.shiftTypes ?? []).find(
                    (shiftType) => shiftType.shiftTypeId === requirement.shiftTypeId,
                  )?.code ?? 'Unknown shift type'}
                </td>
                <td className="border-b border-border p-sp-2">
                  {String(requirement.requiredCount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SurfaceState>
    </section>
  );
}

function problemFor(problems: readonly FieldProblem[], field: string): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}
