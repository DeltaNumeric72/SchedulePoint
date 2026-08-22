import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

import {
  ValidationError,
  createGroupHoliday,
  fetchGroupHolidays,
  fetchPickPositionCount,
  setPickPositionCount,
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
 * Group settings: the draft pick-position count, and the holiday calendar.
 *
 * ## The one irreversible control in the product so far
 *
 * The pick-position count may only ever be increased (research 05 §ADM-07,
 * OBSERVED, and enforced by a database trigger). The interface says so **before**
 * the user acts rather than after — a warning that appears only in the error
 * message is a warning that arrives too late to be one.
 *
 * There is deliberately no typed confirmation on it. SP-E §3 reserves that for
 * genuinely destructive actions; raising a count destroys nothing, it only
 * cannot be undone. Saying so plainly, next to the control, is the honest
 * treatment.
 *
 * ## Two capabilities, one page, and the states are separate
 *
 * Both panels are gated by group-administrator capabilities that a scheduler
 * does not hold, so a scheduler sees the permission-denied state on both — and
 * each panel renders its own, because a single page-level denial would hide the
 * fact that they are two different permissions.
 */

export function GroupSettingsPage(): JSX.Element {
  return (
    <CatalogueLayout
      title="Group settings"
      description="Settings that apply to the whole group rather than to one catalogue entry."
    >
      <PickPositionsPanel />
      <HolidayCalendarPanel />
    </CatalogueLayout>
  );
}

function PickPositionsPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('pick-positions', ['pickPositionCount'] as const);

  const [value, setValue] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const current = useQuery({
    queryKey: ['pick-positions', scope.organizationId, scope.groupId],
    queryFn: () => fetchPickPositionCount(scope),
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => setPickPositionCount(scope, Number(value ?? '0')),
    onSuccess: () => {
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['pick-positions'] });
      void queryClient.invalidateQueries({ queryKey: ['valid-groups'] });
    },
    onError: (error: unknown) =>
      setProblems(error instanceof ValidationError ? error.problems : []),
  });

  const stored = current.data?.pickPositionCount;

  return (
    <section aria-labelledby="pick-positions-heading" className="flex flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="pick-positions-heading">
        Draft pick positions
      </h2>

      <SurfaceState
        isLoading={current.isPending}
        error={current.error}
        isEmpty={false}
        emptyMessage=""
        label="the pick-position count"
      >
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          data-testid="pick-positions-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            save.mutate();
          }}
        >
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="pick-positions" />

          <p className="text-text" data-testid="pick-positions-current">
            This group has{' '}
            <strong>{stored === undefined ? '—' : String(stored)}</strong> numbered draft
            positions.
          </p>

          {/* The warning is a `role="note"`-shaped statement in ordinary prose
              beside the control, not an error after the fact. The word
              "permanently" is doing the work; the warning colour is decoration
              and the sentence reads the same without it. */}
          <p className="rounded-control border border-warning p-sp-3 text-warning">
            Increasing this is permanent. A position that has existed is referenced by published
            history and by valid combinations, and cannot be withdrawn.
          </p>

          <Field
            id={fieldIds.pickPositionCount}
            label="New count"
            help="Must be the same as, or higher than, the current count."
            problem={problems.find((problem) => problem.field === 'pickPositionCount')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                inputMode="numeric"
                name="pickPositionCount"
                value={value ?? String(stored ?? 0)}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>

          <div className="flex flex-wrap items-center gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-pick-positions">
              Save
            </button>
            {save.isSuccess && problems.length === 0 ? (
              <span className="text-success" role="status" aria-live="polite">
                Saved. The count is now {String(save.data.pickPositionCount)}.
              </span>
            ) : null}
          </div>
        </form>
      </SurfaceState>
    </section>
  );
}

function HolidayCalendarPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('holiday', ['holidayDate', 'name', 'observed'] as const);

  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [observed, setObserved] = useState(true);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const list = useQuery({
    queryKey: ['holidays', scope.organizationId, scope.groupId],
    queryFn: () => fetchGroupHolidays(scope),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => createGroupHoliday(scope, { holidayDate: date, name, observed }),
    onSuccess: () => {
      setOpen(false);
      setDate('');
      setName('');
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (error: unknown) =>
      setProblems(error instanceof ValidationError ? error.problems : []),
  });

  const holidays = list.data?.holidays ?? [];

  return (
    <section aria-labelledby="holidays-heading" className="flex flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="holidays-heading">
        Holiday calendar
      </h2>
      <p className="text-text-muted">
        The dates on which holiday demand replaces weekday demand, and against which request
        deadlines are rolled.
      </p>

      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        data-testid="new-holiday"
        aria-expanded={open}
        onClick={() => {
          // I-13 again: this opens a form and writes nothing.
          setOpen((value) => !value);
          setProblems([]);
        }}
      >
        {open ? 'Cancel' : 'Add a holiday'}
      </button>

      {open ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          aria-labelledby="new-holiday-heading"
          data-testid="holiday-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setProblems([]);
            create.mutate();
          }}
        >
          <h3 className="text-lg font-semibold text-text" id="new-holiday-heading">
            Add a holiday
          </h3>
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="holiday" />

          <Field
            id={fieldIds.holidayDate}
            label="Date"
            problem={problems.find((problem) => problem.field === 'holidayDate')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                className={CONTROL_CLASS}
                name="holidayDate"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            )}
          </Field>

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

          <div className="flex min-h-target items-center gap-sp-2">
            <input
              className="h-5 w-5"
              id={fieldIds.observed}
              type="checkbox"
              name="observed"
              checked={observed}
              onChange={(event) => setObserved(event.target.checked)}
            />
            <label className="text-text" htmlFor={fieldIds.observed}>
              This group observes the holiday
            </label>
          </div>

          <div className="flex flex-wrap gap-sp-3">
            <button className={PRIMARY_BUTTON_CLASS} type="submit" data-testid="save-holiday">
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
        isEmpty={holidays.length === 0}
        emptyMessage="No holidays recorded yet. Without a calendar, “the deadline is Friday” is ambiguous when Friday is a holiday."
        label="the holiday calendar"
      >
        {/* `tabIndex={0}`: the portable tab stop for a scrolling container.
            Some browsers focus an overflowing scroller natively; one that does
            not has nothing to send the arrow keys to (I-12, SP-HR-5; axe
            `scrollable-region-focusable`). The name comes from the caption. */}
        <div className="w-full overflow-auto" tabIndex={0}>
          <table className="min-w-full border-collapse text-left" data-testid="holiday-table">
            <caption className="pb-sp-2 text-left text-text-muted">
              {holidays.length === 1 ? '1 holiday' : `${String(holidays.length)} holidays`}
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th className="p-sp-2" scope="col">
                  Date
                </th>
                <th className="p-sp-2" scope="col">
                  Name
                </th>
                <th className="p-sp-2" scope="col">
                  Observed
                </th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((holiday) => (
                <tr className="border-b border-border" key={holiday.groupHolidayId}>
                  <th className="p-sp-2 font-normal text-text" scope="row">
                    <time dateTime={holiday.holidayDate}>{holiday.holidayDate}</time>
                  </th>
                  <td className="p-sp-2 text-text">{holiday.name}</td>
                  {/* Yes/No as WORDS. A tick glyph or a coloured dot would make
                      the column colour- or icon-dependent (SPEC-14 §2). */}
                  <td className="p-sp-2 text-text">{holiday.observed ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SurfaceState>
    </section>
  );
}
