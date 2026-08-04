import {
  SHIFT_PALETTE_KEY_VALUES,
  SHIFT_TEXT_STYLE_VALUES,
  CATALOGUE_DAY_VALUES,
  type ShiftType,
} from '@schedulepoint/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import { ValidationError, createShiftType, fetchShiftTypes, setWeekdayDemand, updateShiftType } from '../api/catalogue.js';
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
import { CatalogueLayout, useGroupScope } from './CatalogueLayout.js';
import { ShiftTypeBadge, ShiftTypeFlags } from './ShiftTypeBadge.js';

/**
 * The shift-type catalogue — the product's first authoring surface (CAP-011).
 *
 * ## I-13, which is the reason this component is shaped the way it is
 *
 * > **No control labelled Add, New, or Create may persist anything before a
 * > completed form, validation, and an explicit Save.** This comes from a real
 * > incident in which such a control created a live record on click.
 *
 * So "New shift type" toggles a piece of LOCAL STATE and nothing else. There is
 * no draft row, no optimistic insert, no `POST` on open, and no id allocated
 * ahead of time. The list does not change until the server has answered a
 * request that only Save issues, and `apps/web/e2e/catalogue.spec.ts` asserts
 * that by counting requests around the click.
 *
 * Optimistic updates are absent for the same reason and are not an oversight:
 * the announced state must match reality (SPEC-14 row 12), and an optimistic row
 * announces a record that may not exist.
 *
 * ## One user action, one request (I-10)
 *
 * The list is fetched once on mount. Save issues exactly one `POST`, and the
 * list is refetched by invalidating the query — which is a second request, and
 * is the correct one: the server is authoritative about what now exists, and
 * splicing the response into the cached list would be the client deciding.
 * Nothing debounces because nothing fetches on keystroke.
 */

const FIELDS = [
  'code',
  'name',
  'description',
  'displayPaletteKey',
  'displayTextStyle',
  'startTime',
  'endTime',
  'isOnCall',
  'attractsStipend',
  'isManualOnly',
  'isDailyPick',
  'includeInStatistics',
  'isLeaveOfAbsence',
  'allowOnRequest',
  'allowOffRequest',
  'reportOrder',
  'creditWeight',
] as const;

interface DraftState {
  code: string;
  name: string;
  description: string;
  displayPaletteKey: (typeof SHIFT_PALETTE_KEY_VALUES)[number];
  displayTextStyle: (typeof SHIFT_TEXT_STYLE_VALUES)[number];
  startTime: string;
  endTime: string;
  isOnCall: boolean;
  attractsStipend: boolean;
  isManualOnly: boolean;
  isDailyPick: boolean;
  includeInStatistics: boolean;
  isLeaveOfAbsence: boolean;
  allowOnRequest: boolean;
  allowOffRequest: boolean;
  reportOrder: string;
  creditWeight: string;
}

const EMPTY_DRAFT: DraftState = {
  code: '',
  name: '',
  description: '',
  displayPaletteKey: 'neutral',
  displayTextStyle: 'regular',
  startTime: '07:00',
  endTime: '19:00',
  isOnCall: false,
  attractsStipend: false,
  isManualOnly: false,
  isDailyPick: false,
  includeInStatistics: true,
  isLeaveOfAbsence: false,
  allowOnRequest: false,
  allowOffRequest: false,
  reportOrder: '0',
  creditWeight: '1',
};

export function ShiftTypesPage(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('shift-type', FIELDS);
  const narrow = useNarrowViewport();

  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [demandFor, setDemandFor] = useState<ShiftType | null>(null);

  const list = useQuery({
    queryKey: ['shift-types', scope.organizationId, scope.groupId],
    queryFn: () => fetchShiftTypes(scope),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      createShiftType(scope, {
        code: draft.code,
        name: draft.name,
        description: draft.description.trim() === '' ? null : draft.description,
        displayPaletteKey: draft.displayPaletteKey,
        displayTextStyle: draft.displayTextStyle,
        startTime: draft.startTime,
        endTime: draft.endTime,
        isOnCall: draft.isOnCall,
        attractsStipend: draft.attractsStipend,
        isManualOnly: draft.isManualOnly,
        isDailyPick: draft.isDailyPick,
        includeInStatistics: draft.includeInStatistics,
        isLeaveOfAbsence: draft.isLeaveOfAbsence,
        allowOnRequest: draft.allowOnRequest,
        allowOffRequest: draft.allowOffRequest,
        reportOrder: Number(draft.reportOrder),
        creditWeight: Number(draft.creditWeight),
      }),
    onSuccess: () => {
      setFormOpen(false);
      setDraft(EMPTY_DRAFT);
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['shift-types'] });
    },
    onError: (error: unknown) => {
      // The server's `422` becomes the summary. The client does not re-word it:
      // the message the user reads is the one the server produced, so the two
      // layers cannot describe the same rule differently.
      setProblems(error instanceof ValidationError ? error.problems : []);
    },
  });

  const retire = useMutation({
    mutationFn: (shiftTypeId: string) => updateShiftType(scope, shiftTypeId, { status: 'retired' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shift-types'] }),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setProblems([]);
    create.mutate();
  }

  const problemFor = (field: string): string | undefined =>
    problems.find((problem) => problem.field === field)?.message;

  const shiftTypes = list.data?.shiftTypes ?? [];

  return (
    <CatalogueLayout
      title="Shift types"
      description="Every kind of work this group schedules, defined once and used everywhere."
    >
      <div className="flex flex-wrap items-center gap-sp-3">
        <button
          type="button"
          className={PRIMARY_BUTTON_CLASS}
          data-testid="new-shift-type"
          aria-expanded={formOpen}
          onClick={() => {
            // I-13: this opens a form. It writes NOTHING, allocates no id, and
            // issues no request. The e2e run asserts the request count is zero.
            setFormOpen((open) => !open);
            setProblems([]);
          }}
        >
          {formOpen ? 'Cancel' : 'New shift type'}
        </button>
        {create.isPending ? (
          <span role="status" aria-live="polite" className="text-text-muted">
            Saving…
          </span>
        ) : null}
      </div>

      {formOpen ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          onSubmit={onSubmit}
          noValidate
          aria-labelledby="new-shift-type-heading"
          data-testid="shift-type-form"
        >
          <h2 className="text-lg font-semibold text-text" id="new-shift-type-heading">
            New shift type
          </h2>

          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="shift-type" />

          {create.isError && problems.length === 0 ? (
            <p className="rounded-panel border border-danger p-sp-3 text-danger" role="alert">
              {create.error instanceof Error
                ? create.error.message
                : 'The request could not be completed.'}
            </p>
          ) : null}

          <div className="grid gap-sp-4 sm:grid-cols-2">
            <Field
              id={fieldIds.code}
              label="Short code"
              help="Shown in grids. Permanent — a code is never re-issued or renamed."
              problem={problemFor('code')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="code"
                  value={draft.code}
                  onChange={(event) => setDraft({ ...draft, code: event.target.value })}
                />
              )}
            </Field>

            <Field id={fieldIds.name} label="Full name" problem={problemFor('name')}>
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              )}
            </Field>

            <Field
              id={fieldIds.startTime}
              label="Start time"
              help="24-hour, HH:MM."
              problem={problemFor('startTime')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="startTime"
                  type="time"
                  value={draft.startTime}
                  onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
                />
              )}
            </Field>

            <Field
              id={fieldIds.endTime}
              label="End time"
              help="An end at or before the start means the shift runs past midnight. You do not need to say so — it is worked out from the two times."
              problem={problemFor('endTime')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="endTime"
                  type="time"
                  value={draft.endTime}
                  onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
                />
              )}
            </Field>

            <Field
              id={fieldIds.displayPaletteKey}
              label="Colour"
              help="Chosen from a set whose contrast has been measured. The code and the colour's name are always shown as text, so colour alone never carries meaning."
            >
              {(attributes) => (
                <select
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="displayPaletteKey"
                  value={draft.displayPaletteKey}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      displayPaletteKey: event.target.value as DraftState['displayPaletteKey'],
                    })
                  }
                >
                  {SHIFT_PALETTE_KEY_VALUES.map((key) => (
                    <option key={key} value={key}>
                      {key.charAt(0).toUpperCase() + key.slice(1)}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field id={fieldIds.displayTextStyle} label="Text style">
              {(attributes) => (
                <select
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="displayTextStyle"
                  value={draft.displayTextStyle}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      displayTextStyle: event.target.value as DraftState['displayTextStyle'],
                    })
                  }
                >
                  {SHIFT_TEXT_STYLE_VALUES.map((key) => (
                    <option key={key} value={key}>
                      {key.charAt(0).toUpperCase() + key.slice(1)}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field
              id={fieldIds.reportOrder}
              label="Report order"
              help="Where this type appears in reports. Lower first."
              problem={problemFor('reportOrder')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="reportOrder"
                  inputMode="numeric"
                  value={draft.reportOrder}
                  onChange={(event) => setDraft({ ...draft, reportOrder: event.target.value })}
                />
              )}
            </Field>

            <Field
              id={fieldIds.creditWeight}
              label="Credit weight"
              help="How much this type counts towards fairness statistics."
              problem={problemFor('creditWeight')}
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="creditWeight"
                  inputMode="decimal"
                  value={draft.creditWeight}
                  onChange={(event) => setDraft({ ...draft, creditWeight: event.target.value })}
                />
              )}
            </Field>
          </div>

          <Field
            id={fieldIds.description}
            label="Description"
            help="Optional."
            problem={problemFor('description')}
          >
            {(attributes) => (
              <textarea
                {...attributes}
                className={CONTROL_CLASS}
                name="description"
                rows={2}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-sp-2 rounded-control border border-border p-sp-3">
            <legend className="px-sp-1 font-medium text-text">Behaviour</legend>
            {(
              [
                ['isOnCall', 'On call'],
                ['attractsStipend', 'Attracts a stipend'],
                ['isManualOnly', 'Assigned manually only'],
                ['isDailyPick', 'Offered in the daily pick'],
                ['includeInStatistics', 'Counts towards statistics'],
                ['isLeaveOfAbsence', 'Is a leave of absence'],
                ['allowOnRequest', 'Staff may request ON this type'],
                ['allowOffRequest', 'Staff may request OFF this type'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex min-h-target items-center gap-sp-2">
                <input
                  className="h-5 w-5"
                  id={fieldIds[key]}
                  name={key}
                  type="checkbox"
                  checked={draft[key]}
                  aria-describedby={problemFor(key) === undefined ? undefined : `${fieldIds[key]}-error`}
                  aria-invalid={problemFor(key) === undefined ? undefined : true}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })}
                />
                <label className="text-text" htmlFor={fieldIds[key]}>
                  {label}
                </label>
                {problemFor(key) === undefined ? null : (
                  <span className="text-sm text-danger" id={`${fieldIds[key]}-error`}>
                    {problemFor(key)}
                  </span>
                )}
              </div>
            ))}
          </fieldset>

          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-shift-type">
              Save
            </button>
            <button
              className={SECONDARY_BUTTON_CLASS}
              type="button"
              onClick={() => {
                setFormOpen(false);
                setProblems([]);
              }}
            >
              Discard
            </button>
          </div>
        </form>
      ) : null}

      <SurfaceState
        isLoading={list.isPending}
        error={list.error}
        isEmpty={shiftTypes.length === 0}
        emptyMessage="No shift types yet. Add the first one to start defining this group's work."
        label="shift types"
      >
        {narrow ? (
          /* The LIST ALTERNATIVE (SPEC-14 grid row, SP-E §1.5). Below 640px a
             six-column table cannot fit without page-level horizontal scrolling,
             which SC 1.4.10 forbids — and a table in a horizontally scrolling box
             is a table most people never see the right-hand half of.

             Exactly ONE of the two representations is in the DOM at a time.
             Rendering both and hiding one with CSS would put every row in the
             accessibility tree twice. */
          <ul className="flex flex-col gap-sp-3" data-testid="shift-type-list">
            {shiftTypes.map((shiftType) => (
              <li
                className="flex flex-col gap-sp-2 rounded-panel border border-border p-sp-3"
                key={shiftType.shiftTypeId}
              >
                <ShiftTypeBadge shiftType={shiftType} />
                <p className="font-medium text-text">{shiftType.name}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-sp-3 gap-y-sp-1">
                  <dt className="text-text-muted">Hours</dt>
                  <dd className="text-text">
                    {shiftType.startTime}–{shiftType.endTime}
                    {shiftType.crossesMidnight ? ' (runs past midnight)' : ''}
                  </dd>
                  <dt className="text-text-muted">Behaviour</dt>
                  <dd>
                    <ShiftTypeFlags shiftType={shiftType} />
                  </dd>
                  <dt className="text-text-muted">Status</dt>
                  <dd className="text-text">
                    {shiftType.status === 'active' ? 'Active' : 'Retired'}
                  </dd>
                </dl>
                <div className="flex flex-wrap gap-sp-2">
                  <button
                    className={SECONDARY_BUTTON_CLASS}
                    type="button"
                    onClick={() => setDemandFor(shiftType)}
                  >
                    Demand
                    <span className="sr-only"> for {shiftType.name}</span>
                  </button>
                  {shiftType.status === 'active' ? (
                    <button
                      className={SECONDARY_BUTTON_CLASS}
                      type="button"
                      onClick={() => retire.mutate(shiftType.shiftTypeId)}
                    >
                      Retire
                      <span className="sr-only"> {shiftType.name}</span>
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          /* A real table with real headers, once there is room for one.
             Virtualisation is deliberately absent: SPEC-14 requires AT row
             navigation to survive it, and a catalogue is tens of rows. */
          <div className="w-full overflow-auto">
            <table className="min-w-full border-collapse text-left" data-testid="shift-type-table">
              <caption className="pb-sp-2 text-left text-text-muted">
                {shiftTypes.length === 1
                  ? '1 shift type'
                  : `${String(shiftTypes.length)} shift types`}
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th className="p-sp-2" scope="col">
                    Code
                  </th>
                  <th className="p-sp-2" scope="col">
                    Name
                  </th>
                  <th className="p-sp-2" scope="col">
                    Hours
                  </th>
                  <th className="p-sp-2" scope="col">
                    Behaviour
                  </th>
                  <th className="p-sp-2" scope="col">
                    Status
                  </th>
                  <th className="p-sp-2" scope="col">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {shiftTypes.map((shiftType) => (
                  <tr className="border-b border-border align-top" key={shiftType.shiftTypeId}>
                    <th className="p-sp-2 font-normal" scope="row">
                      <ShiftTypeBadge shiftType={shiftType} />
                    </th>
                    <td className="p-sp-2 text-text">{shiftType.name}</td>
                    <td className="p-sp-2 text-text">
                      {shiftType.startTime}–{shiftType.endTime}
                      {shiftType.crossesMidnight ? (
                        <span className="block text-sm text-text-muted">Runs past midnight</span>
                      ) : null}
                    </td>
                    <td className="p-sp-2">
                      <ShiftTypeFlags shiftType={shiftType} />
                    </td>
                    <td className="p-sp-2 text-text">
                      {shiftType.status === 'active' ? 'Active' : 'Retired'}
                    </td>
                    <td className="p-sp-2">
                      <div className="flex flex-wrap gap-sp-2">
                        <button
                          className={SECONDARY_BUTTON_CLASS}
                          type="button"
                          onClick={() => setDemandFor(shiftType)}
                        >
                          Demand
                          <span className="sr-only"> for {shiftType.name}</span>
                        </button>
                        {shiftType.status === 'active' ? (
                          <button
                            className={SECONDARY_BUTTON_CLASS}
                            type="button"
                            onClick={() => retire.mutate(shiftType.shiftTypeId)}
                          >
                            Retire
                            <span className="sr-only"> {shiftType.name}</span>
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SurfaceState>

      {demandFor === null ? null : (
        <WeekdayDemandForm
          shiftType={demandFor}
          onClose={() => setDemandFor(null)}
          scope={scope}
        />
      )}
    </CatalogueLayout>
  );
}

/**
 * The per-weekday and holiday demand editor.
 *
 * Eight fields, ONE request (I-10). Eight `PATCH`es would be request
 * amplification wearing a REST costume, and the packet's request budget exists
 * to make that visible rather than arguable.
 */
function WeekdayDemandForm({
  shiftType,
  onClose,
  scope,
}: {
  shiftType: ShiftType;
  onClose: () => void;
  scope: { organizationId: string; groupId: string };
}): JSX.Element {
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('demand', CATALOGUE_DAY_VALUES);
  const [counts, setCounts] = useState<Record<string, string>>(
    Object.fromEntries(CATALOGUE_DAY_VALUES.map((day) => [day, '0'])),
  );
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const save = useMutation({
    mutationFn: () =>
      setWeekdayDemand(scope, shiftType.shiftTypeId, {
        demand: CATALOGUE_DAY_VALUES.map((day) => ({
          day,
          demandCount: Number(counts[day] ?? '0'),
        })),
      }),
    onSuccess: () => {
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['shift-types'] });
      onClose();
    },
    onError: (error: unknown) => {
      setProblems(error instanceof ValidationError ? error.problems : []);
    },
  });

  const LABELS: Readonly<Record<string, string>> = {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
    holiday: 'Holiday',
  };

  return (
    <form
      className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
      aria-labelledby="demand-heading"
      data-testid="demand-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setProblems([]);
        save.mutate();
      }}
    >
      <h2 className="text-lg font-semibold text-text" id="demand-heading">
        Default demand for {shiftType.name}
      </h2>
      <p className="text-text-muted">
        How many people this group needs on each day. Holiday demand replaces the weekday
        figure on the dates in the group&apos;s holiday calendar.
      </p>

      <ValidationSummary problems={problems} fieldIds={fieldIds} formName="demand" />

      <div className="grid gap-sp-3 sm:grid-cols-4">
        {CATALOGUE_DAY_VALUES.map((day) => (
          <Field
            id={fieldIds[day]}
            key={day}
            label={LABELS[day] ?? day}
            problem={problems.find((problem) => problem.field === `demand.${day}`)?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                inputMode="numeric"
                name={`demand-${day}`}
                value={counts[day] ?? '0'}
                onChange={(event) => setCounts({ ...counts, [day]: event.target.value })}
              />
            )}
          </Field>
        ))}
      </div>

      <div className="flex flex-wrap gap-sp-3">
        <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-demand">
          Save demand
        </button>
        <button className={SECONDARY_BUTTON_CLASS} type="button" onClick={onClose}>
          Discard
        </button>
      </div>
    </form>
  );
}
