import {
  selectionStatusForRootStatusWire,
  type VacationRoundWire,
  type VacationSelectionViewWire,
  type VacationVarianceWire,
} from '@schedulepoint/contracts';
import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type JSX } from 'react';

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

import { VacationLayout, useGroupScope } from './VacationLayout.js';
import { VacationRefusal, fetchRound, selectWeek, withdrawSelection } from './api.js';

/**
 * The staff vacation round — the selection surface and the variance display
 * (OPUS-M5-003, doc 42 §5f Part B).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ## R-15 on screen: the status is DERIVED, never stored and never chosen here
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Every row's displayed status comes from `selectionStatusForRootStatusWire`
 * applied to the ROOT's status — SPEC-08 §5.3's table, read in the direction a
 * display needs it. It is not read off `selection.status`, and it is not stored
 * anywhere on the wire or in this component.
 *
 * That is deliberate and it is the invariant, not an implementation detail. §5.3
 * makes the selection's status authoritative and the root's derived; a surface
 * that rendered the selection's status directly would be showing the SAME fact
 * from the OTHER row and would agree with the server right up until the two rows
 * came apart — the exact failure §5.3 was written to remove, arriving in the one
 * place nobody would look for it. Deriving from the root means a mismatch shows
 * as a mismatch, and the server has already refused to answer with one
 * (`readVacationRound` asserts `vacationStatusPairAgrees` on every row before it
 * replies, and D-27 refuses to commit one at all).
 *
 * An `available` week has no root, so the derivation has nothing to read and the
 * row is presented as what it is: a week nobody has claimed yet.
 *
 * ## The ORDER is the server's rule, and this page does not re-sort
 *
 * `compareSelectionsForDisplay` in `packages/domain` pins it — week, then
 * submission instant, then stable id — with a matrix test behind it. A `.sort()`
 * here would be a second ordering in the place a reader actually sees, and it is
 * the copy that would drift. The list is rendered in the order it arrives.
 *
 * ## I-13, and why "Select a week…" opens a form
 *
 * The control does not select anything. It opens a form with a week to choose
 * and an explicit **Save selection**, and opening it issues ZERO requests — the
 * budget `vacation-open-select-week` records the measurement, and it can never be
 * raised without I-13 changing first. This is the invariant's own scenario: a
 * control that claimed a vacation week on click would put a person's leave into a
 * quota ledger before they had finished thinking about it.
 *
 * ## I-10
 *
 * One action, one request. Opening the round is one GET that carries the period,
 * the selections and the variance together; saving is one POST plus one
 * server-authoritative re-read (PO-DEC-18 — the client re-reads what the server
 * says the round is rather than patching its own cache and rendering a round no
 * server produced); a refused save re-reads nothing, because nothing changed.
 *
 * ## CAP-068
 *
 * No third-party host. Every URL this page reaches is same-origin and relative,
 * and there is no font, no icon set, no analytics beacon and no telemetry of any
 * kind on it.
 *
 * ## There is no "change this week" control, and that is structural
 *
 * A selection's week cannot be moved: migration 0022's column-level UPDATE grant
 * on `vacation_selections` does not include `week_start`, so no runtime role can
 * re-point one. Changing a week is WITHDRAW then SELECT AGAIN — two deliberate
 * acts, each audited — and a future packet that wants an edit affordance has to
 * change the grant first, with the argument that a week is what a selection IS.
 */

export function VacationRoundPage(): JSX.Element {
  return (
    <VacationLayout
      title="Vacation round"
      description="The weeks in this round, what you have asked for, and how much of the allowance is left."
    >
      <VacationRoundPanel />
    </VacationLayout>
  );
}

/** Every Monday between the period's bounds — the weeks a member may select. */
function weeksIn(period: VacationRoundWire['period']): readonly string[] {
  const weeks: string[] = [];
  /* Parsed as UTC and stepped in whole days. A vacation week is a fact about a
   * calendar, not about an instant, so nothing here consults a local zone — a
   * `new Date('2029-06-04')` stepped by local days is how a Monday becomes a
   * Sunday for half the world. */
  const start = Date.parse(`${period.startDate}T00:00:00Z`);
  const end = Date.parse(`${period.endDate}T00:00:00Z`);
  for (let at = start; at <= end; at += 7 * 24 * 60 * 60 * 1000) {
    weeks.push(new Date(at).toISOString().slice(0, 10));
  }
  return weeks;
}

/**
 * What a row's status SAYS, derived from the root (R-15).
 *
 * The wording is the requester's, not the schema's: `pending` is "waiting for a
 * decision", because a member reading their own list wants to know whether
 * anybody has looked at it yet.
 */
const STATUS_WORDING: Readonly<Record<string, string>> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  committed: 'On the published schedule',
  denied: 'Not approved',
  withdrawn: 'Taken back',
  expired: 'Expired — nobody decided in time',
  reversed: 'Reversed',
};

function statusOf(view: VacationSelectionViewWire): string {
  if (view.rootStatus === null) return 'Not selected';
  const derived = selectionStatusForRootStatusWire(view.rootStatus);
  /* `null` means the root is standing in a status §5.3's mapping does not
   * produce — a row D-27 refuses to commit. The honest answer is to say so
   * rather than to invent a label for a state that cannot exist. */
  return derived === null ? 'Unknown' : (STATUS_WORDING[derived] ?? derived);
}

function problemsOf(error: unknown): readonly FieldProblem[] {
  if (error instanceof VacationRefusal) return [{ field: 'form', message: error.message }];
  if (error instanceof Error) return [{ field: 'form', message: error.message }];
  return [];
}

function VacationRoundPanel(): JSX.Element {
  const scope = useGroupScope();
  const params = useParams({ strict: false }) as { periodId?: string };
  const periodId = params.periodId ?? '';
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('vacation', ['weekStart'] as const);

  const [open, setOpen] = useState(false);
  const [weekStart, setWeekStart] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const round = useQuery({
    queryKey: ['vacation-round', scope.organizationId, scope.groupId, periodId],
    queryFn: () => fetchRound(scope, periodId),
    retry: false,
  });

  const select = useMutation({
    mutationFn: () =>
      selectWeek(scope, {
        vacationPeriodId: periodId,
        weekStart,
        /* D-7's key, one per attempt at one week. A retry of the SAME attempt
         * replays (R-11); a second, deliberate attempt at the same week is
         * refused by D-22 with its own message rather than silently replaying
         * something the member did not ask for. */
        idempotencyKey: `vac-${periodId.slice(0, 8)}-${weekStart}`,
      }),
    onSuccess: () => {
      setOpen(false);
      setWeekStart('');
      setProblems([]);
      /* One re-read, and the server is the authority on what the round now says
       * (PO-DEC-18). Patching the cache from the response would render a round no
       * server ever produced — and here it would also invent the selection's new
       * VERSION, which the next withdrawal has to present. */
      void queryClient.invalidateQueries({ queryKey: ['vacation-round'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const withdraw = useMutation({
    mutationFn: (target: { selectionId: string; version: number }) =>
      withdrawSelection(scope, target.selectionId, target.version),
    onSuccess: () => {
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['vacation-round'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const data = round.data;
  const selections = data?.selections ?? [];
  const taken = new Set(
    selections
      .filter((view) => view.rootStatus !== null && view.selection.status !== 'withdrawn')
      .map((view) => view.selection.weekStart),
  );
  const selectable = data === undefined ? [] : weeksIn(data.period).filter((week) => !taken.has(week));
  const roundOpen = data?.period.state === 'open';

  return (
    <SurfaceState
      isLoading={round.isPending}
      error={round.error}
      isEmpty={data === undefined}
      emptyMessage="This vacation round is not available."
      label="the vacation round"
    >
      {data === undefined ? null : (
        <>
          <section aria-labelledby="round-heading" className="flex min-w-0 flex-col gap-sp-3">
            <h2 className="text-lg font-semibold text-text" id="round-heading">
              {data.period.startDate} to {data.period.endDate}
            </h2>
            <p className="text-text-muted" data-testid="round-mode">
              {data.period.mode === 'quota'
                ? 'This round runs on an allowance: each approved week uses one unit.'
                : 'This round is open: weeks are reviewed, and no allowance is counted.'}
            </p>

            {roundOpen ? (
              <button
                type="button"
                className={PRIMARY_BUTTON_CLASS}
                data-testid="select-week"
                aria-expanded={open}
                onClick={() => {
                  /* I-13: this opens a form and writes nothing. The e2e budget
                   * for this click is ZERO requests and can never be raised
                   * without the invariant changing first. */
                  setOpen((value) => !value);
                  setProblems([]);
                }}
              >
                {open ? 'Cancel' : 'Select a week…'}
              </button>
            ) : (
              <p className="text-text-muted" data-testid="round-shut">
                This round is not accepting selections.
              </p>
            )}

            {open ? (
              <form
                className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
                aria-labelledby="select-week-heading"
                data-testid="select-week-form"
                noValidate
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  setProblems([]);
                  select.mutate();
                }}
              >
                <h3 className="text-lg font-semibold text-text" id="select-week-heading">
                  Select a week
                </h3>
                <ValidationSummary problems={problems} fieldIds={fieldIds} formName="vacation" />

                <Field
                  id={fieldIds.weekStart}
                  label="Week beginning"
                  help="Weeks run Monday to Friday. Only weeks inside this round are listed."
                  problem={problems.find((problem) => problem.field === 'weekStart')?.message}
                >
                  {(attributes) => (
                    <select
                      {...attributes}
                      className={CONTROL_CLASS}
                      name="weekStart"
                      value={weekStart}
                      onChange={(event) => setWeekStart(event.target.value)}
                    >
                      <option value="">Choose a week</option>
                      {selectable.map((week) => (
                        <option key={week} value={week}>
                          {week}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <button
                  type="submit"
                  className={PRIMARY_BUTTON_CLASS}
                  data-testid="save-selection"
                  disabled={weekStart === ''}
                >
                  Save selection
                </button>
              </form>
            ) : null}
          </section>

          <SelectionList selections={selections} onWithdraw={withdraw.mutate} />
          <VarianceDisplay variance={data.variance} mode={data.period.mode} />
        </>
      )}
    </SurfaceState>
  );
}

/**
 * The member's weeks, in the order the server sent them.
 *
 * A table, because it is tabular: four facts about each of several weeks, and a
 * list of paragraphs would make "which of my weeks were approved" a reading
 * exercise. Every column has a header cell, so a screen reader announces which
 * fact it is reading.
 */
function SelectionList({
  selections,
  onWithdraw,
}: {
  readonly selections: readonly VacationSelectionViewWire[];
  readonly onWithdraw: (target: { selectionId: string; version: number }) => void;
}): JSX.Element {
  return (
    <section aria-labelledby="selections-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="selections-heading">
        Your weeks
      </h2>

      {selections.length === 0 ? (
        <p className="text-text-muted" data-testid="no-selections">
          You have not asked for any weeks in this round yet.
        </p>
      ) : (
        /* The one element allowed to scroll sideways is this container, never the
           page (AC-08): a table with four columns at 320px has to go somewhere. */
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-0 border-collapse text-left" data-testid="selections">
            <caption className="sr-only">
              Your vacation weeks in this round, earliest first.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                  Week beginning
                </th>
                <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                  Status
                </th>
                <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                  Submitted
                </th>
                <th scope="col" className="border-b border-border py-sp-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {selections.map((view) => (
                <tr key={view.selection.id} data-testid={`selection-${view.selection.weekStart}`}>
                  <td className="border-b border-border py-sp-2 pr-sp-3">
                    {view.selection.weekStart}
                  </td>
                  <td
                    className="border-b border-border py-sp-2 pr-sp-3"
                    data-testid={`status-${view.selection.weekStart}`}
                  >
                    {statusOf(view)}
                    {view.isLate ? (
                      <span className="ml-sp-2 text-text-muted">(late)</span>
                    ) : null}
                  </td>
                  <td className="border-b border-border py-sp-2 pr-sp-3">
                    {view.submittedAt === null ? '—' : view.submittedAt.slice(0, 10)}
                  </td>
                  <td className="border-b border-border py-sp-2">
                    {view.selection.status === 'pending' || view.selection.status === 'approved' ? (
                      <button
                        type="button"
                        className={SECONDARY_BUTTON_CLASS}
                        data-testid={`withdraw-${view.selection.weekStart}`}
                        onClick={() =>
                          onWithdraw({
                            selectionId: view.selection.id,
                            /* The SELECTION's version, never the root's (V-29).
                             * The server guards on it, so a stale button in a
                             * second tab is refused rather than believed. */
                            version: view.selection.version,
                          })
                        }
                      >
                        Take back<span className="sr-only"> the week of {view.selection.weekStart}</span>
                      </button>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * §5.5's variance display — **advisory, never blocking**.
 *
 * Doc 09 §2.1: *"Over-quota is advisory, not blocking. The variance indicator
 * warns; approval still succeeds."* Nothing on this page consults it to decide
 * anything, and no control is disabled by it. It is a warning a person reads.
 *
 * The vocabulary is [report 12](../../../../schedulepoint-research/reports/12-product-glossary.md)
 * TERM-051's three renamed numbers: the ENTITLEMENT (the allowance), the BALANCE
 * (what is left of it), and the WEEKLY CAPACITY (the per-week ceiling across the
 * group). "Grant", "Avail" and "Weekly Quota" are the source product's words and
 * the glossary's disposition is to RENAME all three — so they do not appear here.
 *
 * **Empty in open mode, and that is not an error** — V-30: an open round has no
 * grant rows at all, and a surface that read an empty list as "no allowance left"
 * would be reintroducing the defect V-30 fixed.
 */
function VarianceDisplay({
  variance,
  mode,
}: {
  readonly variance: readonly VacationVarianceWire[];
  readonly mode: 'quota' | 'open';
}): JSX.Element {
  return (
    <section aria-labelledby="variance-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="variance-heading">
        Allowance
      </h2>

      {mode === 'open' ? (
        <p className="text-text-muted" data-testid="variance-open-mode">
          This round does not count an allowance. Weeks are reviewed on their merits.
        </p>
      ) : variance.length === 0 ? (
        <p className="text-text-muted" data-testid="variance-empty">
          No allowance has been set for this round yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-sp-2" data-testid="variance">
          {variance.map((row) => (
            <li
              key={row.grantId}
              className="rounded-panel border border-border p-sp-3"
              data-testid={`variance-${row.grantId}`}
            >
              <p className="font-medium text-text">
                {row.kind === 'personal-entitlement'
                  ? 'Your entitlement for this round'
                  : `Weekly capacity for the week of ${row.weekStart ?? ''}`}
              </p>
              <p className="text-text-muted">
                {row.unitsConsumed} of {row.unitsTotal} used · {row.remaining} left
              </p>
              {row.state === 'over-entitlement' ? (
                /* An alert, not a colour: the warning has to reach somebody who
                 * cannot see the colour it is drawn in (I-12, SP-HR-3..6). It
                 * still blocks nothing. */
                <p role="alert" className="text-text" data-testid={`variance-over-${row.grantId}`}>
                  {row.overEntitlement} week(s) beyond the entitlement, approved as an override.
                </p>
              ) : row.state === 'at-entitlement' ? (
                <p className="text-text" data-testid={`variance-at-${row.grantId}`}>
                  The entitlement is fully used.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
