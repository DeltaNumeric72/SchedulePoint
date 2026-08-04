import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import {
  ValidationError,
  createShiftGroup,
  createStaffGroup,
  createValidGroup,
  fetchShiftGroups,
  fetchShiftTypes,
  fetchStaffGroups,
  fetchValidGroups,
} from '../api/catalogue.js';
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
import { CatalogueLayout, useGroupScope } from './CatalogueLayout.js';

/**
 * The three bundling surfaces: shift groups, staff groups, and valid
 * combinations (CAP-012 and CAP-011).
 *
 * They share the shift-type page's contracts exactly — I-13 (the New control
 * writes nothing), submit-only validation, a `role="alert"` summary that links
 * to fields, and the five surface states — and they are here together because
 * repeating three near-identical files would have been three places for those
 * contracts to drift.
 *
 * What they do NOT share is a generic "resource page" abstraction. Each of the
 * three has a genuinely different form — a discriminated scoring pair, a plain
 * name, a set of ids crossed with a set of ordinals — and flattening them into
 * one configurable component would have made every one of those differences a
 * runtime branch in a component nobody can read.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Shift groups
 * ──────────────────────────────────────────────────────────────────────────── */

const SHIFT_GROUP_FIELDS = [
  'name',
  'description',
  'scoringMode',
  'weight',
  'allowRequest',
  'requestOffLabel',
  'shiftTypeIds',
] as const;

export function ShiftGroupsPage(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('shift-group', SHIFT_GROUP_FIELDS);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scoringMode, setScoringMode] = useState<'hard' | 'weighted'>('hard');
  const [weight, setWeight] = useState('1000');
  const [allowRequest, setAllowRequest] = useState(false);
  const [requestOffLabel, setRequestOffLabel] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const list = useQuery({
    queryKey: ['shift-groups', scope.organizationId, scope.groupId],
    queryFn: () => fetchShiftGroups(scope),
    retry: false,
  });

  const shiftTypes = useQuery({
    queryKey: ['shift-types', scope.organizationId, scope.groupId],
    queryFn: () => fetchShiftTypes(scope),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      createShiftGroup(scope, {
        name,
        description: null,
        // The discriminated union is built here rather than sent as a flat
        // object with a nullable weight: `{ scoringMode: 'hard', weight: 0 }` is
        // a parse error in the contract, which is what stops the meaningless
        // "Hard (0)" state ever reaching the database.
        scoring:
          scoringMode === 'hard'
            ? { scoringMode: 'hard' }
            : { scoringMode: 'weighted', weight: Number(weight) },
        request: allowRequest ? { allowRequest: true, requestOffLabel } : { allowRequest: false },
        shiftTypeIds: [...selected],
      }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      setSelected([]);
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['shift-groups'] });
    },
    onError: (error: unknown) =>
      setProblems(error instanceof ValidationError ? error.problems : []),
  });

  const groups = list.data?.shiftGroups ?? [];
  const problemFor = (field: string): string | undefined =>
    problems.find((problem) => problem.field === field)?.message;

  return (
    <CatalogueLayout
      title="Shift groups"
      description="Bundles of shift types, used for fairness scoring and for request-off targeting."
    >
      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        data-testid="new-shift-group"
        aria-expanded={open}
        onClick={() => {
          // I-13: opens a form. Writes nothing.
          setOpen((value) => !value);
          setProblems([]);
        }}
      >
        {open ? 'Cancel' : 'New shift group'}
      </button>

      {open ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          aria-labelledby="new-shift-group-heading"
          data-testid="shift-group-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            create.mutate();
          }}
        >
          <h2 className="text-lg font-semibold text-text" id="new-shift-group-heading">
            New shift group
          </h2>
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="shift-group" />

          <Field id={fieldIds.name} label="Name" problem={problemFor('name')}>
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-sp-2 rounded-control border border-border p-sp-3">
            <legend className="px-sp-1 font-medium text-text">Scoring</legend>
            <p className="text-sm text-text-muted">
              A hard bundle is a constraint the schedule may not break. A weighted bundle is a
              preference with a numeric weight.
            </p>
            {(
              [
                ['hard', 'Hard — a constraint, with no weight'],
                ['weighted', 'Weighted — a preference'],
              ] as const
            ).map(([value, label]) => (
              <div className="flex min-h-target items-center gap-sp-2" key={value}>
                <input
                  className="h-5 w-5"
                  id={`${fieldIds.scoringMode}-${value}`}
                  type="radio"
                  name="scoringMode"
                  value={value}
                  checked={scoringMode === value}
                  onChange={() => setScoringMode(value)}
                />
                <label className="text-text" htmlFor={`${fieldIds.scoringMode}-${value}`}>
                  {label}
                </label>
              </div>
            ))}
            {scoringMode === 'weighted' ? (
              <Field id={fieldIds.weight} label="Weight" problem={problemFor('weight')}>
                {(attributes) => (
                  <input
                    {...attributes}
                    className={CONTROL_CLASS}
                    inputMode="numeric"
                    name="weight"
                    value={weight}
                    onChange={(event) => setWeight(event.target.value)}
                  />
                )}
              </Field>
            ) : null}
          </fieldset>

          <div className="flex min-h-target items-center gap-sp-2">
            <input
              className="h-5 w-5"
              id={fieldIds.allowRequest}
              type="checkbox"
              name="allowRequest"
              checked={allowRequest}
              onChange={(event) => setAllowRequest(event.target.checked)}
            />
            <label className="text-text" htmlFor={fieldIds.allowRequest}>
              Staff may request off this whole bundle
            </label>
          </div>

          {allowRequest ? (
            <Field
              id={fieldIds.requestOffLabel}
              label="Request-off wording"
              help="The exact phrasing staff will see, for example “Request off all on-call shifts”."
              problem={problemFor('requestOffLabel')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="requestOffLabel"
                  value={requestOffLabel}
                  onChange={(event) => setRequestOffLabel(event.target.value)}
                />
              )}
            </Field>
          ) : null}

          <fieldset className="flex flex-col gap-sp-2 rounded-control border border-border p-sp-3">
            <legend className="px-sp-1 font-medium text-text">Member shift types</legend>
            {(shiftTypes.data?.shiftTypes ?? []).length === 0 ? (
              <p className="text-text-muted">
                No shift types are defined yet. A bundle can be created empty and filled in later.
              </p>
            ) : (
              (shiftTypes.data?.shiftTypes ?? []).map((shiftType) => (
                <div className="flex min-h-target items-center gap-sp-2" key={shiftType.shiftTypeId}>
                  <input
                    className="h-5 w-5"
                    id={`${fieldIds.shiftTypeIds}-${shiftType.shiftTypeId}`}
                    type="checkbox"
                    checked={selected.includes(shiftType.shiftTypeId)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, shiftType.shiftTypeId]
                          : selected.filter((id) => id !== shiftType.shiftTypeId),
                      )
                    }
                  />
                  <label
                    className="text-text"
                    htmlFor={`${fieldIds.shiftTypeIds}-${shiftType.shiftTypeId}`}
                  >
                    {shiftType.code} — {shiftType.name}
                  </label>
                </div>
              ))
            )}
            {problemFor('shiftTypeIds') === undefined ? null : (
              <p className="text-sm text-danger">{problemFor('shiftTypeIds')}</p>
            )}
          </fieldset>

          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-shift-group">
              Save
            </button>
            <button className={SECONDARY_BUTTON_CLASS} type="button" onClick={() => setOpen(false)}>
              Discard
            </button>
          </div>
        </form>
      ) : null}

      <SurfaceState
        isLoading={list.isPending}
        error={list.error}
        isEmpty={groups.length === 0}
        emptyMessage="No shift groups yet. Bundle shift types together to score them as a set or to let staff request off all of them at once."
        label="shift groups"
      >
        <div className="w-full overflow-auto">
          <table className="min-w-full border-collapse text-left" data-testid="shift-group-table">
            <caption className="pb-sp-2 text-left text-text-muted">
              {groups.length === 1 ? '1 shift group' : `${String(groups.length)} shift groups`}
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th className="p-sp-2" scope="col">
                  Name
                </th>
                <th className="p-sp-2" scope="col">
                  Scoring
                </th>
                <th className="p-sp-2" scope="col">
                  Requests
                </th>
                <th className="p-sp-2" scope="col">
                  Members
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr className="border-b border-border" key={group.shiftGroupId}>
                  <th className="p-sp-2 font-normal text-text" scope="row">
                    {group.name}
                  </th>
                  <td className="p-sp-2 text-text">
                    {group.scoringMode === 'hard'
                      ? 'Hard constraint'
                      : `Weighted (${String(group.weight ?? 0)})`}
                  </td>
                  <td className="p-sp-2 text-text">
                    {group.allowRequest ? (group.requestOffLabel ?? 'Allowed') : 'Not offered'}
                  </td>
                  <td className="p-sp-2 text-text">{group.shiftTypeIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SurfaceState>
    </CatalogueLayout>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Staff groups
 * ──────────────────────────────────────────────────────────────────────────── */

export function StaffGroupsPage(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('staff-group', ['name'] as const);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const list = useQuery({
    queryKey: ['staff-groups', scope.organizationId, scope.groupId],
    queryFn: () => fetchStaffGroups(scope),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => createStaffGroup(scope, { name, description: null, membershipIds: [] }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['staff-groups'] });
    },
    onError: (error: unknown) =>
      setProblems(error instanceof ValidationError ? error.problems : []),
  });

  const groups = list.data?.staffGroups ?? [];

  return (
    <CatalogueLayout
      title="Staff groups"
      description="Named subsets of people, for scoping eligibility and visibility. Deliberately separate from shift groups: they bundle different things for different reasons."
    >
      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        data-testid="new-staff-group"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setProblems([]);
        }}
      >
        {open ? 'Cancel' : 'New staff group'}
      </button>

      {open ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          aria-labelledby="new-staff-group-heading"
          data-testid="staff-group-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            create.mutate();
          }}
        >
          <h2 className="text-lg font-semibold text-text" id="new-staff-group-heading">
            New staff group
          </h2>
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="staff-group" />
          <Field
            id={fieldIds.name}
            label="Name"
            help="Members are added once the membership surfaces ship."
            problem={problems.find((problem) => problem.field === 'name')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-staff-group">
              Save
            </button>
            <button className={SECONDARY_BUTTON_CLASS} type="button" onClick={() => setOpen(false)}>
              Discard
            </button>
          </div>
        </form>
      ) : null}

      <SurfaceState
        isLoading={list.isPending}
        error={list.error}
        isEmpty={groups.length === 0}
        emptyMessage="No staff groups yet."
        label="staff groups"
      >
        <ul className="flex flex-col gap-sp-2" data-testid="staff-group-list">
          {groups.map((group) => (
            <li
              className="rounded-panel border border-border p-sp-3 text-text"
              key={group.staffGroupId}
            >
              {group.name}
              <span className="ml-sp-2 text-sm text-text-muted">
                {group.membershipIds.length === 1
                  ? '1 member'
                  : `${String(group.membershipIds.length)} members`}
              </span>
            </li>
          ))}
        </ul>
      </SurfaceState>
    </CatalogueLayout>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Valid combinations
 * ──────────────────────────────────────────────────────────────────────────── */

export function ValidGroupsPage(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('valid-group', ['name', 'shiftTypeIds', 'allowedPickPositions'] as const);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<readonly string[]>([]);
  const [selectedPositions, setSelectedPositions] = useState<readonly number[]>([]);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const list = useQuery({
    queryKey: ['valid-groups', scope.organizationId, scope.groupId],
    queryFn: () => fetchValidGroups(scope),
    retry: false,
  });

  const shiftTypes = useQuery({
    queryKey: ['shift-types', scope.organizationId, scope.groupId],
    queryFn: () => fetchShiftTypes(scope),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      createValidGroup(scope, {
        name,
        shiftTypeIds: [...selectedTypes],
        // Sorted and de-duplicated before sending. The server refuses a
        // non-canonical array rather than silently fixing it, so producing the
        // canonical form is the client's job and doing it deliberately here is
        // what keeps the refusal meaningful.
        allowedPickPositions: [...new Set(selectedPositions)].sort((a, b) => a - b),
      }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      setSelectedTypes([]);
      setSelectedPositions([]);
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['valid-groups'] });
    },
    onError: (error: unknown) =>
      setProblems(error instanceof ValidationError ? error.problems : []),
  });

  const ceiling = list.data?.pickPositionCount ?? 0;
  const groups = list.data?.validGroups ?? [];

  return (
    <CatalogueLayout
      title="Valid combinations"
      description="Which numbered draft positions are legal for a given set of shift types."
    >
      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        data-testid="new-valid-group"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setProblems([]);
        }}
      >
        {open ? 'Cancel' : 'New valid combination'}
      </button>

      {open ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          aria-labelledby="new-valid-group-heading"
          data-testid="valid-group-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            create.mutate();
          }}
        >
          <h2 className="text-lg font-semibold text-text" id="new-valid-group-heading">
            New valid combination
          </h2>
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="valid-group" />

          <Field
            id={fieldIds.name}
            label="Name"
            problem={problems.find((problem) => problem.field === 'name')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-sp-2 rounded-control border border-border p-sp-3">
            <legend className="px-sp-1 font-medium text-text">Shift types</legend>
            {(shiftTypes.data?.shiftTypes ?? []).map((shiftType) => (
              <div className="flex min-h-target items-center gap-sp-2" key={shiftType.shiftTypeId}>
                <input
                  className="h-5 w-5"
                  id={`${fieldIds.shiftTypeIds}-${shiftType.shiftTypeId}`}
                  type="checkbox"
                  checked={selectedTypes.includes(shiftType.shiftTypeId)}
                  onChange={(event) =>
                    setSelectedTypes(
                      event.target.checked
                        ? [...selectedTypes, shiftType.shiftTypeId]
                        : selectedTypes.filter((id) => id !== shiftType.shiftTypeId),
                    )
                  }
                />
                <label
                  className="text-text"
                  htmlFor={`${fieldIds.shiftTypeIds}-${shiftType.shiftTypeId}`}
                >
                  {shiftType.code} — {shiftType.name}
                </label>
              </div>
            ))}
            {problems.find((problem) => problem.field === 'shiftTypeIds') === undefined ? null : (
              <p className="text-sm text-danger">
                {problems.find((problem) => problem.field === 'shiftTypeIds')?.message}
              </p>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-sp-2 rounded-control border border-border p-sp-3">
            <legend className="px-sp-1 font-medium text-text">Pick positions</legend>
            {ceiling === 0 ? (
              <p className="text-text-muted" data-testid="no-pick-positions">
                This group has no numbered draft positions yet. Set the count in{' '}
                <strong>Group settings</strong> first — the count can only ever be increased.
              </p>
            ) : (
              <div className="flex flex-wrap gap-sp-2">
                {Array.from({ length: ceiling }, (_, index) => index + 1).map((position) => (
                  <div className="flex min-h-target items-center gap-sp-1" key={position}>
                    <input
                      className="h-5 w-5"
                      id={`${fieldIds.allowedPickPositions}-${String(position)}`}
                      type="checkbox"
                      checked={selectedPositions.includes(position)}
                      onChange={(event) =>
                        setSelectedPositions(
                          event.target.checked
                            ? [...selectedPositions, position]
                            : selectedPositions.filter((value) => value !== position),
                        )
                      }
                    />
                    <label
                      className="text-text"
                      htmlFor={`${fieldIds.allowedPickPositions}-${String(position)}`}
                    >
                      {position}
                    </label>
                  </div>
                ))}
              </div>
            )}
            {problems.find((problem) => problem.field === 'allowedPickPositions') ===
            undefined ? null : (
              <p className="text-sm text-danger">
                {problems.find((problem) => problem.field === 'allowedPickPositions')?.message}
              </p>
            )}
          </fieldset>

          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-valid-group">
              Save
            </button>
            <button className={SECONDARY_BUTTON_CLASS} type="button" onClick={() => setOpen(false)}>
              Discard
            </button>
          </div>
        </form>
      ) : null}

      <SurfaceState
        isLoading={list.isPending}
        error={list.error}
        isEmpty={groups.length === 0}
        emptyMessage="No valid combinations yet. Without one, no pairing of shift type and draft position is constrained."
        label="valid combinations"
      >
        <div className="w-full overflow-auto">
          <table className="min-w-full border-collapse text-left" data-testid="valid-group-table">
            <caption className="pb-sp-2 text-left text-text-muted">
              {groups.length === 1
                ? '1 valid combination'
                : `${String(groups.length)} valid combinations`}
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th className="p-sp-2" scope="col">
                  Name
                </th>
                <th className="p-sp-2" scope="col">
                  Shift types
                </th>
                <th className="p-sp-2" scope="col">
                  Allowed positions
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr className="border-b border-border" key={group.validGroupId}>
                  <th className="p-sp-2 font-normal text-text" scope="row">
                    {group.name}
                  </th>
                  <td className="p-sp-2 text-text">{group.shiftTypeIds.length}</td>
                  <td className="p-sp-2 text-text">
                    {group.allowedPickPositions.length === 0
                      ? 'None'
                      : group.allowedPickPositions.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SurfaceState>
    </CatalogueLayout>
  );
}
