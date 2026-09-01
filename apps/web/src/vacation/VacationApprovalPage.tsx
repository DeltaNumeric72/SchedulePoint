import type {
  CommitVacationRoundResultWire,
  VacationSelectionViewWire,
  VacationVarianceWire,
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
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import { fetchPeriods, fetchVersions } from '../schedule/api.js';

import { VacationLayout, useGroupScope } from './VacationLayout.js';
import {
  VacationRefusal,
  approveSelection,
  commitRound,
  denySelection,
  fetchRoundSelections,
  reverseCommittedWeek,
} from './api.js';

/**
 * **The scheduler's vacation round — approve, deny, commit, and reverse**
 * (OPUS-M5-005; SPEC-08 §5.4/§5.5/§5.6, and the graduated confirmation §5h
 * routed to this packet).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ## The REVERSAL is two steps, and never one click. This is the packet's owed
 * ## affordance, and it is the reason this page looks the way it does.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * A reversal takes back a vacation week that is ALREADY ON A PUBLISHED SCHEDULE.
 * Three things happen and none of them is obvious from a button labelled
 * "Reverse", so the confirmation NAMES ALL THREE before it will accept anything:
 *
 *  1. **the quota unit is restored** — §5.5's release path. In `open` mode
 *     nothing is released, because there is no grant row at all (V-30), and the
 *     confirmation says which of the two this round is rather than promising a
 *     release that will not happen.
 *  2. **a revision request is raised** — and the published version is NOT
 *     edited. `reverseVacationCommitResultSchema.revisionRequested` is a literal
 *     `true` because §5.6 always raises one. The wording is deliberate: a person
 *     reading "reversed" will assume the schedule changed, and it did not. Somebody
 *     now has to publish a corrected version.
 *  3. **the snapshots are retained** — the OFF assignment snapshots the commit
 *     created stay. Nothing is deleted; I-18 means a published version is never
 *     mutated, so history is added to rather than rewritten.
 *
 * And it carries the MANDATORY reason (§5.6), which is what makes a two-step
 * confirmation the honest shape rather than a modal for its own sake: the second
 * step cannot be satisfied by clicking, because it requires a sentence. The
 * first step is an explicit acknowledgement of the three consequences; the
 * second is the reason. Neither is skippable and the order is fixed.
 *
 * **I-13 on both steps.** Opening the confirmation issues ZERO requests
 * (`vacation-open-reverse-confirm`), and completing the acknowledgement issues
 * ZERO (`vacation-fill-reverse-confirm`). Only the final submit reaches the
 * server.
 *
 * ## FU-36: `isOverride` is rendered with its DISAMBIGUATOR, never alone
 *
 * The flag carries two facts under one name — "approved beyond the allowance"
 * and "a reversal reason is recorded on this row" — because 0022's frozen
 * equality `is_override = (override_reason IS NOT NULL)` plus §5.6's mandatory
 * reversal reason force the second. The selection's STATUS is what tells them
 * apart, and `overrideMeaning` below is the ONLY thing that renders the flag: it
 * returns `null` for a row without it and reads `selection.status` to choose
 * between the two sentences, so the two cannot be separated by any caller. A row
 * in `reversed` says "a reason is recorded for the reversal"; any other status
 * says "approved beyond the allowance". Neither sentence can be produced without
 * the status having decided it.
 *
 * ## The APPROVAL states what supplying an override reason does and does not do
 *
 * §5.5's reason is required when the approval exceeds the bound — and supplying
 * it authorises nothing. The override capability is evaluated server-side inside
 * the transaction, and without it the approval is refused by name
 * (`OVERRIDE_REQUIRED`) whatever the body said. The form says so, because a
 * field that looks like it grants a power is a field that will be filled in by
 * somebody who does not have it and cannot understand the refusal.
 *
 * ## The variance display is ADVISORY and blocks NOTHING
 *
 * Doc 09 §2.1: "Over-quota is advisory, not blocking. The variance indicator
 * warns; approval still succeeds." No control on this page is disabled by it.
 * It is empty in `open` mode, and that is not an error — V-30: an open round has
 * no grant rows at all, and reading an empty list as "no allowance left" is the
 * defect V-30 fixed.
 *
 * ## I-10
 *
 * The page load is TWO reads that answer two different questions: the round's
 * selections, and the group's schedule periods (a commit must target a DRAFT
 * schedule version, and no route maps a vacation round to a schedule period, so
 * the scheduler chooses). Choosing a period reads that period's versions — one
 * action, one request, the same shape as opening the assignment picker on the
 * grid. Every decision is one write plus ONE server-authoritative re-read.
 *
 * ## CAP-068 — no third-party host anywhere on this page.
 */

export function VacationApprovalPage(): JSX.Element {
  return (
    <VacationLayout
      title="Vacation round — review"
      description="Every week asked for in this round, the allowance behind it, and the acts a scheduler may perform: approve, deny, commit the round into a draft schedule, and reverse a committed week."
    >
      <ApprovalPanel />
    </VacationLayout>
  );
}

function problemsOf(error: unknown): readonly FieldProblem[] {
  if (error instanceof VacationRefusal) return [{ field: 'form', message: error.message }];
  if (error instanceof Error) return [{ field: 'form', message: error.message }];
  return [];
}

/**
 * What a selection's status SAYS — read from the SELECTION here, and that is a
 * deliberate difference from the member's round page.
 *
 * The member's page derives the displayed status from the ROOT through §5.3's
 * table (R-15), because a member is reading their own request's progress. This
 * page is the DECIDER's, and what a decider acts on is the selection's own
 * status: `pending` is what `approve` and `deny` require (R-18/R-19) and
 * `committed` is what `reverse` requires. Showing a derived word while the
 * buttons keyed off a different value would be the two coming apart on screen.
 *
 * The pair is still checkable rather than trusted: the server asserts
 * `vacationStatusPairAgrees` on every row before it answers, and `rootStatus`
 * comes back beside the selection so the disagreement it refuses to render would
 * be visible here too.
 */
const STATUS_LABELS: Readonly<Record<VacationSelectionViewWire['selection']['status'], string>> = {
  available: 'Not selected',
  pending: 'Waiting for a decision',
  approved: 'Approved',
  committed: 'On a schedule version',
  denied: 'Not approved',
  withdrawn: 'Taken back',
  expired: 'Expired — nobody decided in time',
  reversed: 'Reversed',
};

/**
 * FU-36's disambiguation, as one function so it cannot be done by halves.
 *
 * Called only with a row that HAS the flag set, and it reads the STATUS to
 * decide which of the two facts the flag is carrying. Returning `null` for a row
 * without the flag means a caller cannot render the sentence for a row it did
 * not check.
 */
function overrideMeaning(view: VacationSelectionViewWire): string | null {
  if (!view.selection.isOverride) return null;
  return view.selection.status === 'reversed'
    ? 'a reason is recorded for the reversal'
    : 'approved beyond the allowance';
}

function ApprovalPanel(): JSX.Element {
  const scope = useGroupScope();
  const params = useParams({ strict: false }) as { periodId?: string };
  const periodId = params.periodId ?? '';
  const queryClient = useQueryClient();

  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [denying, setDenying] = useState<VacationSelectionViewWire | null>(null);
  const [reversing, setReversing] = useState<VacationSelectionViewWire | null>(null);
  const [reason, setReason] = useState('');

  const round = useQuery({
    queryKey: ['vacation-round-selections', scope.organizationId, scope.groupId, periodId],
    queryFn: () => fetchRoundSelections(scope, periodId),
    retry: false,
  });

  function afterWrite(): void {
    setDenying(null);
    setReversing(null);
    setReason('');
    setProblems([]);
    void queryClient.invalidateQueries({ queryKey: ['vacation-round-selections'] });
  }

  const approve = useMutation({
    mutationFn: (view: VacationSelectionViewWire) =>
      approveSelection(scope, view.selection.id, {
        /* D-26's key, one per attempt at one selection. Derived from the
         * selection and the version it was read at, so a genuine RETRY of the
         * same attempt replays (R-17) and consumes nothing a second time, while
         * a later, deliberate attempt after the version moved is a new key. */
        approvalIdempotencyKey: `vap-${view.selection.id.slice(0, 8)}-${String(view.selection.version)}`,
        expectedSelectionVersion: view.selection.version,
      }),
    onSuccess: afterWrite,
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const deny = useMutation({
    mutationFn: (input: { view: VacationSelectionViewWire; reason: string }) =>
      denySelection(scope, input.view.selection.id, {
        approvalIdempotencyKey: `vdn-${input.view.selection.id.slice(0, 8)}-${String(input.view.selection.version)}`,
        expectedSelectionVersion: input.view.selection.version,
        reason: input.reason,
      }),
    onSuccess: afterWrite,
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const reverse = useMutation({
    mutationFn: (input: { view: VacationSelectionViewWire; reason: string }) =>
      reverseCommittedWeek(scope, input.view.selection.id, input.reason),
    onSuccess: afterWrite,
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const data = round.data;

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
            <p className="text-text-muted" data-testid="approval-round-mode">
              {data.period.mode === 'quota'
                ? 'This round runs on an allowance: each approved week uses one unit.'
                : 'This round is open: weeks are reviewed on their merits, and no allowance is counted.'}
            </p>
          </section>

          {problems.length === 0 ? null : (
            <p
              role="alert"
              className="rounded-panel border border-danger p-sp-3 text-text"
              data-testid="approval-problem"
            >
              {problems.map((problem) => problem.message).join(' ')}
            </p>
          )}

          <SelectionTable
            selections={data.selections}
            onApprove={approve.mutate}
            onDeny={(view) => {
              setProblems([]);
              setReason('');
              setDenying(view);
              setReversing(null);
            }}
            onReverse={(view) => {
              /* I-13: opens the confirmation, reverses nothing. ZERO requests. */
              setProblems([]);
              setReason('');
              setReversing(view);
              setDenying(null);
            }}
          />

          {denying === null ? null : (
            <DenyForm
              view={denying}
              reason={reason}
              onReason={setReason}
              problems={problems}
              isPending={deny.isPending}
              onCancel={() => {
                setDenying(null);
                setReason('');
                setProblems([]);
              }}
              onSubmit={() => {
                if (reason.trim() === '') {
                  setProblems([{ field: 'reason', message: 'A denial says why. Enter a reason.' }]);
                  return;
                }
                setProblems([]);
                deny.mutate({ view: denying, reason });
              }}
            />
          )}

          {reversing === null ? null : (
            <ReverseConfirmation
              view={reversing}
              mode={data.period.mode}
              reason={reason}
              onReason={setReason}
              problems={problems}
              isPending={reverse.isPending}
              onCancel={() => {
                setReversing(null);
                setReason('');
                setProblems([]);
              }}
              onSubmit={() => {
                if (reason.trim() === '') {
                  setProblems([
                    { field: 'reason', message: 'A reversal says why. Enter a reason.' },
                  ]);
                  return;
                }
                setProblems([]);
                reverse.mutate({ view: reversing, reason });
              }}
            />
          )}

          <VarianceDisplay variance={data.variance} mode={data.period.mode} />
          <CommitPanel periodId={periodId} />
        </>
      )}
    </SurfaceState>
  );
}

function SelectionTable({
  selections,
  onApprove,
  onDeny,
  onReverse,
}: {
  readonly selections: readonly VacationSelectionViewWire[];
  readonly onApprove: (view: VacationSelectionViewWire) => void;
  readonly onDeny: (view: VacationSelectionViewWire) => void;
  readonly onReverse: (view: VacationSelectionViewWire) => void;
}): JSX.Element {
  const narrow = useNarrowViewport();
  return (
    <section aria-labelledby="selections-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="selections-heading">
        Weeks asked for
      </h2>

      {selections.length === 0 ? (
        <p className="text-text-muted" data-testid="no-round-selections">
          Nobody has asked for a week in this round.
        </p>
      ) : /* **The list alternative, not a sideways scroll (AC-08, SC 1.4.10).**
           Measured: at 320px this table's min-content width is 363px and an
           `overflow-x-auto` wrapper did not stop the PAGE scrolling sideways —
           hiding the table took the page overflow from 42px to 0. So the house
           answer applies, the one `useNarrowViewport` exists for: below 640px the
           SAME rows render as a list, chosen in JavaScript rather than hidden
           with CSS so each week is in the accessibility tree once. The per-row
           and per-control test ids are identical in both. */
      narrow ? (
        <ul className="flex flex-col gap-sp-2" data-testid="round-selections">
          {selections.map((view) => (
            <SelectionCard
              key={view.selection.id}
              view={view}
              onApprove={onApprove}
              onDeny={onDeny}
              onReverse={onReverse}
            />
          ))}
        </ul>
      ) : (
        <table className="w-full min-w-0 border-collapse text-left" data-testid="round-selections">
          <caption className="sr-only">Every week asked for in this round, earliest first.</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                Week beginning
              </th>
              <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                Who
              </th>
              <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                Status
              </th>
              <th scope="col" className="border-b border-border py-sp-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {selections.map((view) => {
              const meaning = overrideMeaning(view);
              return (
                <tr key={view.selection.id} data-testid={`row-${view.selection.id}`}>
                  <td className="border-b border-border py-sp-2 pr-sp-3">
                    {view.selection.weekStart}
                  </td>
                  <td className="border-b border-border py-sp-2 pr-sp-3">
                    <span className="font-mono text-sm">
                      {view.selection.membershipId.slice(0, 8)}
                    </span>
                    <span className="sr-only"> membership {view.selection.membershipId}</span>
                  </td>
                  <td
                    className="border-b border-border py-sp-2 pr-sp-3"
                    data-testid={`row-status-${view.selection.id}`}
                  >
                    {STATUS_LABELS[view.selection.status]}
                    {view.isLate ? <span className="ml-sp-2 text-text-muted">(late)</span> : null}
                    {meaning === null ? null : (
                      /* FU-36: the flag is never rendered without the status
                           having decided which of its two facts it is carrying. */
                      <span
                        className="ml-sp-2 text-text-muted"
                        data-testid={`row-override-${view.selection.id}`}
                      >
                        — {meaning}
                      </span>
                    )}
                  </td>
                  <td className="border-b border-border py-sp-2">
                    <div className="flex flex-wrap gap-sp-2">
                      <SelectionActions
                        view={view}
                        onApprove={onApprove}
                        onDeny={onDeny}
                        onReverse={onReverse}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * One week as a CARD — the same facts, the same acts, the same accessible names.
 *
 * `SelectionActions` and `overrideMeaning` are shared with the row, so the two
 * representations cannot come to offer different affordances for the same
 * status, and FU-36's disambiguation cannot be done in one and forgotten in the
 * other.
 */
function SelectionCard({
  view,
  onApprove,
  onDeny,
  onReverse,
}: {
  readonly view: VacationSelectionViewWire;
  readonly onApprove: (view: VacationSelectionViewWire) => void;
  readonly onDeny: (view: VacationSelectionViewWire) => void;
  readonly onReverse: (view: VacationSelectionViewWire) => void;
}): JSX.Element {
  const meaning = overrideMeaning(view);
  return (
    <li
      className="flex min-w-0 flex-col gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-3"
      data-testid={`row-${view.selection.id}`}
    >
      <p className="font-medium text-text">Week of {view.selection.weekStart}</p>
      <p className="text-text">
        <span className="font-mono text-sm">{view.selection.membershipId.slice(0, 8)}</span>
        <span className="sr-only"> membership {view.selection.membershipId}</span>
      </p>
      <p className="text-text" data-testid={`row-status-${view.selection.id}`}>
        {STATUS_LABELS[view.selection.status]}
        {view.isLate ? <span className="ml-sp-2 text-text-muted">(late)</span> : null}
        {meaning === null ? null : (
          <span
            className="ml-sp-2 text-text-muted"
            data-testid={`row-override-${view.selection.id}`}
          >
            — {meaning}
          </span>
        )}
      </p>
      <div className="flex flex-wrap gap-sp-2">
        <SelectionActions view={view} onApprove={onApprove} onDeny={onDeny} onReverse={onReverse} />
      </div>
    </li>
  );
}

/**
 * The acts a week's STATUS permits — written once, rendered by both the row and
 * the card.
 *
 * `pending` gets approve and deny (R-18/R-19 require it); `committed` gets
 * reverse (§5.6); everything else gets nothing, because there is nothing a
 * decider may do to it. Sharing this is what keeps the narrow surface from
 * quietly offering an act the wide one does not.
 */
function SelectionActions({
  view,
  onApprove,
  onDeny,
  onReverse,
}: {
  readonly view: VacationSelectionViewWire;
  readonly onApprove: (view: VacationSelectionViewWire) => void;
  readonly onDeny: (view: VacationSelectionViewWire) => void;
  readonly onReverse: (view: VacationSelectionViewWire) => void;
}): JSX.Element {
  if (view.selection.status === 'pending') {
    return (
      <>
        <button
          type="button"
          className={PRIMARY_BUTTON_CLASS}
          data-testid={`approve-${view.selection.id}`}
          onClick={() => onApprove(view)}
        >
          Approve
          <span className="sr-only"> the week of {view.selection.weekStart}</span>
        </button>
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          data-testid={`deny-${view.selection.id}`}
          onClick={() => onDeny(view)}
        >
          Deny…
          <span className="sr-only"> the week of {view.selection.weekStart}</span>
        </button>
      </>
    );
  }
  if (view.selection.status === 'committed') {
    return (
      <button
        type="button"
        className={SECONDARY_BUTTON_CLASS}
        data-testid={`reverse-${view.selection.id}`}
        onClick={() => onReverse(view)}
      >
        Reverse…
        <span className="sr-only"> the committed week of {view.selection.weekStart}</span>
      </button>
    );
  }
  return <span className="text-text-muted">—</span>;
}

function DenyForm({
  view,
  reason,
  onReason,
  problems,
  isPending,
  onCancel,
  onSubmit,
}: {
  readonly view: VacationSelectionViewWire;
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly problems: readonly FieldProblem[];
  readonly isPending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}): JSX.Element {
  const fieldIds = useFieldIds('deny-week', ['reason'] as const);
  return (
    <form
      className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
      aria-labelledby="deny-week-heading"
      data-testid="deny-week-form"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h3 className="text-lg font-semibold text-text" id="deny-week-heading">
        Deny the week of {view.selection.weekStart}
      </h3>
      <ValidationSummary problems={problems} fieldIds={fieldIds} formName="deny-week" />
      <p className="text-text" data-testid="deny-week-note">
        A denial consumes nothing: no allowance unit is used, and none is returned.
      </p>
      <Field
        id={fieldIds.reason}
        label="Reason"
        help="Required. At most 1000 characters. Recorded on the decision and read back with it."
        problem={problems.find((problem) => problem.field === 'reason')?.message}
      >
        {(attributes) => (
          <textarea
            {...attributes}
            className={CONTROL_CLASS}
            data-testid="deny-week-reason"
            maxLength={1000}
            rows={3}
            value={reason}
            onChange={(event) => onReason(event.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-sp-2">
        <button
          type="submit"
          className={PRIMARY_BUTTON_CLASS}
          data-testid="deny-week-submit"
          disabled={isPending}
        >
          {isPending ? 'Denying…' : 'Deny it'}
        </button>
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          data-testid="deny-week-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * **§5.6's reversal, behind a GRADUATED confirmation.**
 *
 * Step 1 names the three consequences and requires an explicit acknowledgement.
 * Step 2 requires the mandatory reason. The submit is disabled until BOTH are
 * satisfied, so this cannot become a one-click destructive act by anybody's
 * hurry — which is the whole of what §5h routed here.
 *
 * The acknowledgement is a checkbox with the three consequences beside it rather
 * than above it, because a checkbox labelled "I understand" next to prose nobody
 * has to pass through is a click, not an acknowledgement.
 */
function ReverseConfirmation({
  view,
  mode,
  reason,
  onReason,
  problems,
  isPending,
  onCancel,
  onSubmit,
}: {
  readonly view: VacationSelectionViewWire;
  readonly mode: 'quota' | 'open';
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly problems: readonly FieldProblem[];
  readonly isPending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}): JSX.Element {
  const fieldIds = useFieldIds('reverse-week', ['acknowledged', 'reason'] as const);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <form
      className="flex flex-col gap-sp-4 rounded-panel border border-danger bg-surface-raised p-sp-4"
      aria-labelledby="reverse-week-heading"
      data-testid="reverse-week-form"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h3 className="text-lg font-semibold text-text" id="reverse-week-heading">
        Reverse the committed week of {view.selection.weekStart}
      </h3>
      <ValidationSummary problems={problems} fieldIds={fieldIds} formName="reverse-week" />

      <div data-testid="reverse-consequences">
        <p className="text-text">
          This week is already on a published schedule. Reversing it does three things:
        </p>
        <ul className="mt-sp-2 list-disc pl-sp-5 text-text">
          <li data-testid="consequence-units">
            {mode === 'quota'
              ? 'The allowance unit this week used is returned to the entitlement it came from.'
              : 'No allowance unit is returned, because this round does not count an allowance.'}
          </li>
          <li data-testid="consequence-revision">
            A revision is requested. <strong>The published schedule is not changed by this.</strong>{' '}
            Somebody has to publish a corrected version; until they do, the schedule people are
            working to still shows this week off.
          </li>
          <li data-testid="consequence-snapshots">
            The assignment snapshots the commit created are kept. Nothing is deleted — a published
            version is never edited, so the record grows rather than being rewritten.
          </li>
        </ul>
      </div>

      {/* STEP 1 — the acknowledgement. Zero requests to reach or to complete. */}
      <div className="flex items-start gap-sp-2">
        <input
          type="checkbox"
          className="mt-sp-1 min-h-target min-w-target"
          id={fieldIds.acknowledged}
          data-testid="reverse-acknowledge"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <label className="text-text" htmlFor={fieldIds.acknowledged}>
          I have read what happens, and I understand that the published schedule does not change
          until a corrected version is published.
        </label>
      </div>

      {/* STEP 2 — the mandatory reason. Revealed only after step 1, so the two
          steps are sequential rather than two boxes on one screen. */}
      {acknowledged ? (
        <Field
          id={fieldIds.reason}
          label="Why is this week being reversed"
          help="Required by SPEC-08 §5.6. At most 1000 characters. This is an administrative note; it is never part of a notification."
          problem={problems.find((problem) => problem.field === 'reason')?.message}
        >
          {(attributes) => (
            <textarea
              {...attributes}
              className={CONTROL_CLASS}
              data-testid="reverse-reason"
              maxLength={1000}
              rows={3}
              value={reason}
              onChange={(event) => onReason(event.target.value)}
            />
          )}
        </Field>
      ) : (
        <p className="text-sm text-text-muted" data-testid="reverse-step-two-pending">
          A reason is required. It appears once you have acknowledged what happens.
        </p>
      )}

      <div className="flex flex-wrap gap-sp-2">
        <button
          type="submit"
          className={PRIMARY_BUTTON_CLASS}
          data-testid="reverse-submit"
          /* BOTH steps, and in flight. There is no path from the table to a
             completed reversal that passes through fewer than two deliberate
             acts plus a sentence. */
          disabled={!acknowledged || reason.trim() === '' || isPending}
        >
          {isPending ? 'Reversing…' : 'Reverse this week'}
        </button>
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          data-testid="reverse-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * §5.5's variance — advisory, never blocking (doc 09 §2.1).
 *
 * The vocabulary is report 12 TERM-051's three renamed numbers: the ENTITLEMENT,
 * the BALANCE, and the WEEKLY CAPACITY. "Grant", "Avail" and "Weekly Quota" are
 * the source product's words and the glossary's disposition is to RENAME all
 * three, so they do not appear here.
 */
function VarianceDisplay({
  variance,
  mode,
}: {
  readonly variance: readonly VacationVarianceWire[];
  readonly mode: 'quota' | 'open';
}): JSX.Element {
  return (
    <section aria-labelledby="approval-variance-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="approval-variance-heading">
        Allowance
      </h2>
      {mode === 'open' ? (
        <p className="text-text-muted" data-testid="approval-variance-open">
          This round does not count an allowance. Nothing here limits what may be approved.
        </p>
      ) : variance.length === 0 ? (
        <p className="text-text-muted" data-testid="approval-variance-empty">
          No allowance has been set for this round yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-sp-2" data-testid="approval-variance">
          {variance.map((row) => (
            <li
              key={row.grantId}
              className="rounded-panel border border-border p-sp-3"
              data-testid={`approval-variance-${row.grantId}`}
            >
              <p className="font-medium text-text">
                {row.kind === 'personal-entitlement'
                  ? `Entitlement for membership ${row.membershipId?.slice(0, 8) ?? ''}`
                  : `Weekly capacity for the week of ${row.weekStart ?? ''}`}
              </p>
              <p className="text-text-muted">
                {row.unitsConsumed} of {row.unitsTotal} used · {row.remaining} left
              </p>
              {row.state === 'over-entitlement' ? (
                /* An alert, not a colour: the warning has to reach somebody who
                   cannot see the colour it is drawn in (I-12, SP-HR-3..6). It
                   still blocks nothing — no control on this page reads it. */
                <p
                  role="alert"
                  className="text-text"
                  data-testid={`approval-variance-over-${row.grantId}`}
                >
                  {row.overEntitlement} week(s) beyond the entitlement, approved as an override.
                  This is a warning, not a limit — an approval still succeeds.
                </p>
              ) : row.state === 'at-entitlement' ? (
                <p className="text-text" data-testid={`approval-variance-at-${row.grantId}`}>
                  The entitlement is fully used. Approving another week records an override, and
                  requires a reason.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * §5.6's COMMIT — the round into a DRAFT schedule version.
 *
 * The target is chosen rather than inferred, because no route maps a vacation
 * round to a schedule period: the two are separate concepts the glossary keeps
 * apart, and a commit names the DRAFT version it writes OFF assignments into. A
 * published version is refused BY NAME (`COMMIT_TARGET_NOT_DRAFT`, I-18), and
 * the form says so rather than filtering the list down and leaving a scheduler
 * wondering where their version went.
 */
function CommitPanel({ periodId }: { readonly periodId: string }): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('commit', ['schedulePeriod', 'targetVersion'] as const);

  const [open, setOpen] = useState(false);
  const [schedulePeriodId, setSchedulePeriodId] = useState('');
  const [targetVersionId, setTargetVersionId] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [result, setResult] = useState<CommitVacationRoundResultWire | null>(null);

  const periods = useQuery({
    queryKey: ['schedule-periods', scope.organizationId, scope.groupId],
    queryFn: () => fetchPeriods(scope),
    retry: false,
  });

  /* One action, one request: the versions for the period the scheduler just
   * chose. `enabled` keeps it from firing on an empty selection, so opening the
   * form still costs ZERO. */
  const versions = useQuery({
    queryKey: ['schedule-versions', scope.organizationId, scope.groupId, schedulePeriodId],
    queryFn: () => fetchVersions(scope, schedulePeriodId),
    enabled: schedulePeriodId !== '',
    retry: false,
  });

  const drafts = (versions.data?.versions ?? []).filter((version) => version.state === 'draft');

  const commit = useMutation({
    mutationFn: () =>
      commitRound(scope, periodId, {
        targetVersionId,
        /* FAD-59's key, and the ONLY thing that makes a retry safe: the same key
         * twice commits once (R-12) and the answer says `replayed`. Derived from
         * the round and the target, so retrying the same commit is the same key
         * and committing into a different draft is a different one. */
        idempotencyKey: `vcm-${periodId.slice(0, 8)}-${targetVersionId.slice(0, 8)}`,
      }),
    onSuccess: (value) => {
      setResult(value);
      setOpen(false);
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['vacation-round-selections'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  return (
    <section aria-labelledby="commit-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="commit-heading">
        Commit this round
      </h2>
      <p className="text-text-muted" data-testid="commit-explainer">
        A commit takes <strong>every approved week</strong> in this round and writes it into a draft
        schedule version as time off. It is an act on the round, not on a selection — there is no
        way to commit some of it.
      </p>

      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        data-testid="open-commit"
        aria-expanded={open}
        onClick={() => {
          /* I-13: opens a form and writes nothing. ZERO requests — the versions
           * read below is gated on a period actually being chosen. */
          setOpen((value) => !value);
          setProblems([]);
        }}
      >
        {open ? 'Cancel' : 'Commit this round…'}
      </button>

      {open ? (
        <form
          className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
          aria-labelledby="commit-form-heading"
          data-testid="commit-form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (targetVersionId === '') {
              setProblems([
                { field: 'targetVersion', message: 'Choose the draft version to commit into.' },
              ]);
              return;
            }
            setProblems([]);
            commit.mutate();
          }}
        >
          <h3 className="text-lg font-semibold text-text" id="commit-form-heading">
            Commit into a draft version
          </h3>
          <ValidationSummary problems={problems} fieldIds={fieldIds} formName="commit" />

          <Field
            id={fieldIds.schedulePeriod}
            label="Schedule period"
            help="A vacation round and a schedule period are different things. Choose the schedule period this round's weeks fall inside."
          >
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="commit-period"
                value={schedulePeriodId}
                onChange={(event) => {
                  setSchedulePeriodId(event.target.value);
                  setTargetVersionId('');
                }}
              >
                <option value="">Choose a schedule period</option>
                {(periods.data?.periods ?? []).map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.name}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            id={fieldIds.targetVersion}
            label="Draft version"
            help="Only drafts are listed. Committing into a published version is refused — a published version is never edited."
            problem={problems.find((problem) => problem.field === 'targetVersion')?.message}
          >
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="commit-version"
                value={targetVersionId}
                disabled={schedulePeriodId === ''}
                onChange={(event) => setTargetVersionId(event.target.value)}
              >
                <option value="">
                  {schedulePeriodId === '' ? 'Choose a schedule period first' : 'Choose a draft'}
                </option>
                {drafts.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <button
            type="submit"
            className={PRIMARY_BUTTON_CLASS}
            data-testid="commit-submit"
            disabled={commit.isPending}
          >
            {commit.isPending ? 'Committing…' : 'Commit the round'}
          </button>
        </form>
      ) : null}

      {result === null ? null : (
        <div
          className="rounded-panel border border-border bg-surface-raised p-sp-4"
          role="status"
          aria-live="polite"
          data-testid="commit-result"
        >
          {result.replayed ? (
            /* R-12 said in words. A replay is not a second commit and must not
               read like one — the ledger already held this key and nothing was
               written. */
            <p className="text-text" data-testid="commit-replayed">
              This round had already been committed with this command. Nothing was written a second
              time; the recorded outcome is shown.
            </p>
          ) : null}
          <p className="text-text">
            {result.committedSelectionIds.length} week(s) committed, {result.assignmentsCreated}{' '}
            time -off assignment(s) written.
          </p>
        </div>
      )}
    </section>
  );
}
