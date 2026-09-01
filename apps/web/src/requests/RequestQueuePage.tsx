import type {
  DecisionItemOutcomeWire,
  RequestRecordWire,
  RequestStatusWire,
  RequestSubtypeWire,
  RequestWire,
} from '@schedulepoint/contracts';
import { Link } from '@tanstack/react-router';
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

import { RequestsLayout, useGroupScope } from './RequestsLayout.js';
import { RequestRefusal, decideBatch, fetchQueue } from './api.js';
import {
  QUEUE_STATUSES,
  STATUS_LABELS,
  SUBMITTABLE_SUBTYPES,
  SUBTYPE_LABELS,
} from './vocabulary.js';

/**
 * **The scheduler's pending-review queue** (OPUS-M5-005; SPEC-08 §4, doc 42
 * §5d Part C's read routes).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ## The queue is the five non-vacation subtypes, and that is the SERVER's rule
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Not a filter this page applies. `listPendingReview` skips vacation roots —
 * §5.3 gives that lifecycle one reader and it is not the request store — so a
 * caller that asked for `subtype=vacation-selection` would receive an empty
 * list. The filter below therefore does not offer it, and the surface says where
 * vacation weeks are decided instead of leaving a scheduler to discover an
 * always-empty option.
 *
 * ## The queue names people by MEMBERSHIP, not by name, and says so
 *
 * There is no shipped read that returns a roster with names: `requestQueueSchema`
 * carries `membershipId` and nothing else about the person, and the contacts
 * directory (CAP-042) is M5-00D's, with its own PII decision, migration and
 * server-side field minimisation — "the API never returns fields the UI hides;
 * hiding in the client is not minimisation" (doc 11 §8). Reaching into another
 * surface's roster to synthesise a name here would be doing that minimisation
 * decision by accident, in the client, which is the one place it must not be
 * done. So the column shows what the server sent, labelled honestly. The cost of
 * that was priced rather than overlooked, and it is what M5-00D cures.
 *
 * ## I-10 and I-13 on the batch
 *
 * Selecting rows issues NOTHING (`queue-select-rows`, budget zero): a checkbox
 * is not a decision. Opening the batch form issues NOTHING
 * (`queue-open-batch`, budget zero) — I-13 in the form the invariant states, and
 * a control that decided twenty requests on click is the incident it comes from.
 * Deciding is ONE request for the whole batch (`queue-batch-decision`), which is
 * why the contract takes a list: twenty decisions in twenty requests would be
 * the amplification I-10 forbids, and the bound of 100 keeps one action from
 * holding row locks proportional to how many boxes somebody ticked.
 *
 * ## A partial batch failure is rendered PER ITEM, never as a count
 *
 * The answer is one outcome per item, in the order sent, discriminated on `ok`.
 * This page renders every one of them — a batch that half-succeeded and reported
 * "done" is exactly the failure the per-item shape exists to prevent, and a
 * summary line would reintroduce it in the display layer. The five failure
 * reasons are a closed vocabulary and each is said in words a scheduler can act
 * on, because they have different remedies: reload, nothing-to-retry, and
 * decide-it-somewhere-else are three different situations.
 *
 * ## CAP-068 — no third-party host, on this page or any it links to.
 */

export function RequestQueuePage(): JSX.Element {
  return (
    <RequestsLayout
      title="Requests to review"
      description="Requests waiting for a decision in this group. Deciding one is a separate, recorded act; deciding several at once is one act with one reason."
    >
      <QueuePanel />
    </RequestsLayout>
  );
}

function problemsOf(error: unknown): readonly FieldProblem[] {
  if (error instanceof RequestRefusal) return [{ field: 'form', message: error.message }];
  if (error instanceof Error) return [{ field: 'form', message: error.message }];
  return [];
}

/** What each closed failure member MEANS, and what to do about it. */
const BATCH_FAILURE_WORDING: Readonly<
  Record<Extract<DecisionItemOutcomeWire, { ok: false }>['failure'], string>
> = {
  'not-found': 'This request is no longer visible here.',
  'illegal-operation': 'Somebody has already decided this one. There is nothing to retry.',
  'version-conflict': 'This request changed while you were looking. Reload and decide it again.',
  'reason-required': 'This decision needs a reason.',
  'subtype-not-decidable-here':
    'This kind of request is not decided here — a shift preference is never approved, and a vacation week is decided on the round.',
};

function whenOf(record: RequestRecordWire): string {
  if ('targetDate' in record) return record.targetDate;
  if ('rangeStart' in record) return `${record.rangeStart} to ${record.rangeEnd}`;
  if ('weekStart' in record) return `week of ${record.weekStart}`;
  return '—';
}

function QueuePanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('batch', ['decision', 'reason'] as const);

  const [subtype, setSubtype] = useState<RequestSubtypeWire | ''>('');
  const [status, setStatus] = useState<RequestStatusWire | ''>('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'denied'>('approved');
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [outcomes, setOutcomes] = useState<readonly DecisionItemOutcomeWire[] | null>(null);
  const narrow = useNarrowViewport();

  const queue = useQuery({
    queryKey: ['request-queue', scope.organizationId, scope.groupId, subtype, status],
    queryFn: () =>
      fetchQueue(scope, {
        ...(subtype === '' ? {} : { subtypes: [subtype] }),
        ...(status === '' ? {} : { statuses: [status] }),
      }),
    retry: false,
  });

  const rows = queue.data?.requests ?? [];
  const selectedRows = rows.filter((request) => selected.includes(request.root.id));

  const batch = useMutation({
    mutationFn: () =>
      decideBatch(scope, {
        decision,
        /* A denial's reason is MANDATORY and an approval's is not offered at all
         * — §4 asks for one on a denial and §5.5 on an override, and neither asks
         * on an ordinary approval. `null` rather than an empty string, because
         * the contract's trimmed bound refuses whitespace and an empty string is
         * a value, not an absence. */
        reason: decision === 'denied' ? reason : null,
        items: selectedRows.map((request) => ({
          requestId: request.root.id,
          expectedVersion: request.root.version,
        })),
      }),
    onSuccess: (result) => {
      setOutcomes(result.outcomes);
      setBatchOpen(false);
      setSelected([]);
      setReason('');
      setProblems([]);
      /* One re-read. The server is the authority on what the queue now holds
       * (PO-DEC-18) — and after a PARTIAL batch it is the only thing that knows
       * which rows moved, so synthesising the new queue from the outcomes would
       * be inventing a list. */
      void queryClient.invalidateQueries({ queryKey: ['request-queue'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  return (
    <>
      <section aria-labelledby="filter-heading" className="flex min-w-0 flex-col gap-sp-3">
        <h2 className="text-lg font-semibold text-text" id="filter-heading">
          Narrow the queue
        </h2>
        <div className="flex flex-wrap gap-sp-4">
          <Field id="queue-subtype" label="Kind">
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="filter-subtype"
                value={subtype}
                onChange={(event) => setSubtype(event.target.value as RequestSubtypeWire | '')}
              >
                <option value="">Every kind</option>
                {SUBMITTABLE_SUBTYPES.map((value) => (
                  <option key={value} value={value}>
                    {SUBTYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="queue-status" label="Status">
            {(attributes) => (
              <select
                {...attributes}
                className={CONTROL_CLASS}
                data-testid="filter-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as RequestStatusWire | '')}
              >
                <option value="">Waiting for a decision</option>
                {QUEUE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <p className="text-sm text-text-muted" data-testid="queue-vacation-note">
          Vacation weeks are not in this queue. They are decided on the vacation round, where the
          allowance and the week are shown together.
        </p>
      </section>

      <SurfaceState
        isLoading={queue.isPending}
        error={queue.error}
        isEmpty={queue.data !== undefined && rows.length === 0}
        emptyMessage="Nothing is waiting for a decision here."
        label="the review queue"
      >
        {queue.data === undefined ? null : (
          <>
            <section aria-labelledby="queue-heading" className="flex min-w-0 flex-col gap-sp-3">
              <h2 className="text-lg font-semibold text-text" id="queue-heading">
                Waiting for a decision
              </h2>

              {/* **The list alternative, not a sideways scroll (AC-08, SC 1.4.10).**
                  Measured: at 320px this six-column table's min-content width is
                  442px and an `overflow-x-auto` wrapper did not stop the PAGE
                  scrolling sideways. The house answer applies — `useNarrowViewport`
                  exists for exactly this, and `my-schedule` and `builds` already
                  use it: below 640px the SAME rows render as a list, chosen in
                  JavaScript rather than hidden with CSS so a screen-reader user
                  hears each request once rather than twice. Per-row test ids are
                  identical in both, because they name the REQUEST. */}
              {narrow ? (
                <ul className="flex flex-col gap-sp-2" data-testid="queue">
                  {rows.map((request) => (
                    <QueueCard
                      key={request.root.id}
                      request={request}
                      isSelected={selected.includes(request.root.id)}
                      onToggle={(id) =>
                        setSelected((current) =>
                          current.includes(id)
                            ? current.filter((value) => value !== id)
                            : [...current, id],
                        )
                      }
                      scope={scope}
                    />
                  ))}
                </ul>
              ) : (
                <table className="w-full min-w-0 border-collapse text-left" data-testid="queue">
                  <caption className="sr-only">
                    Requests waiting for a decision, earliest deadline first.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                        <span className="sr-only">Select for a batch decision</span>
                      </th>
                      <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                        Kind
                      </th>
                      <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                        When
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
                    {rows.map((request) => (
                      <QueueRow
                        key={request.root.id}
                        request={request}
                        isSelected={selected.includes(request.root.id)}
                        onToggle={(id) =>
                          setSelected((current) =>
                            current.includes(id)
                              ? current.filter((value) => value !== id)
                              : [...current, id],
                          )
                        }
                        scope={scope}
                      />
                    ))}
                  </tbody>
                </table>
              )}

              <p className="text-sm text-text-muted" data-testid="queue-identity-note">
                People are shown by their membership identifier. Names come with the contacts
                directory, which carries its own decision about which fields may be shown to whom.
              </p>
            </section>

            <section aria-labelledby="batch-heading" className="flex min-w-0 flex-col gap-sp-3">
              <h2 className="text-lg font-semibold text-text" id="batch-heading">
                Decide several at once
              </h2>
              <p className="text-text" data-testid="batch-count">
                {selected.length === 0
                  ? 'Select requests above to decide them together.'
                  : `${String(selected.length)} selected.`}
              </p>

              {selected.length === 0 ? null : (
                <button
                  type="button"
                  className={PRIMARY_BUTTON_CLASS}
                  data-testid="open-batch"
                  aria-expanded={batchOpen}
                  onClick={() => {
                    /* I-13: opens a form, decides nothing, writes nothing. The
                     * budget for this click is ZERO and cannot be raised without
                     * the invariant changing first. */
                    setBatchOpen((value) => !value);
                    setProblems([]);
                  }}
                >
                  {batchOpen ? 'Cancel' : 'Decide these together…'}
                </button>
              )}

              {batchOpen ? (
                <form
                  className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
                  aria-labelledby="batch-form-heading"
                  data-testid="batch-form"
                  noValidate
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    if (decision === 'denied' && reason.trim() === '') {
                      setProblems([
                        { field: 'reason', message: 'A denial says why. Enter a reason.' },
                      ]);
                      return;
                    }
                    setProblems([]);
                    batch.mutate();
                  }}
                >
                  <h3 className="text-lg font-semibold text-text" id="batch-form-heading">
                    Decide {selected.length} request{selected.length === 1 ? '' : 's'}
                  </h3>
                  <ValidationSummary problems={problems} fieldIds={fieldIds} formName="batch" />

                  <Field id={fieldIds.decision} label="Decision">
                    {(attributes) => (
                      <select
                        {...attributes}
                        className={CONTROL_CLASS}
                        data-testid="batch-decision"
                        value={decision}
                        onChange={(event) =>
                          setDecision(event.target.value as 'approved' | 'denied')
                        }
                      >
                        <option value="approved">Approve</option>
                        <option value="denied">Deny</option>
                      </select>
                    )}
                  </Field>

                  {decision === 'denied' ? (
                    <Field
                      id={fieldIds.reason}
                      label="Reason"
                      help="Required for a denial, and stored on every one of these decisions so each still carries its explanation when read back alone. At most 1000 characters."
                      problem={problems.find((problem) => problem.field === 'reason')?.message}
                    >
                      {(attributes) => (
                        <textarea
                          {...attributes}
                          className={CONTROL_CLASS}
                          data-testid="batch-reason"
                          maxLength={1000}
                          rows={3}
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      )}
                    </Field>
                  ) : (
                    <p className="text-sm text-text-muted" data-testid="batch-no-reason">
                      An approval carries no reason. Only a denial, and an approval that exceeds an
                      allowance, are required to say why.
                    </p>
                  )}

                  <button
                    type="submit"
                    className={PRIMARY_BUTTON_CLASS}
                    data-testid="batch-submit"
                    disabled={batch.isPending}
                  >
                    {batch.isPending ? 'Deciding…' : 'Decide them'}
                  </button>
                </form>
              ) : null}

              {outcomes === null ? null : <BatchOutcomes outcomes={outcomes} />}
            </section>
          </>
        )}
      </SurfaceState>
    </>
  );
}

function QueueRow({
  request,
  isSelected,
  onToggle,
  scope,
}: {
  readonly request: RequestWire;
  readonly isSelected: boolean;
  readonly onToggle: (id: string) => void;
  readonly scope: { organizationId: string; groupId: string };
}): JSX.Element {
  const { root, record } = request;
  return (
    <tr data-testid={`queue-row-${root.id}`}>
      <td className="border-b border-border py-sp-2 pr-sp-3">
        <input
          type="checkbox"
          className="min-h-target min-w-target"
          data-testid={`select-${root.id}`}
          checked={isSelected}
          onChange={() => onToggle(root.id)}
          /* The accessible name says WHICH request, because "checkbox, checked"
             read out six times in a column is not a choice anybody can make. */
          aria-label={`Select the ${SUBTYPE_LABELS[root.subtype]} request on ${whenOf(record)} for a batch decision`}
        />
      </td>
      <td className="border-b border-border py-sp-2 pr-sp-3">{SUBTYPE_LABELS[root.subtype]}</td>
      <td className="border-b border-border py-sp-2 pr-sp-3">{whenOf(record)}</td>
      <td className="border-b border-border py-sp-2 pr-sp-3">
        <span className="font-mono text-sm">{root.membershipId.slice(0, 8)}</span>
        <span className="sr-only"> membership {root.membershipId}</span>
      </td>
      <td className="border-b border-border py-sp-2 pr-sp-3">
        {STATUS_LABELS[root.status]}
        {root.isLate ? <span className="ml-sp-2 text-text-muted">(late)</span> : null}
      </td>
      <td className="border-b border-border py-sp-2">
        <Link
          className={SECONDARY_BUTTON_CLASS}
          data-testid={`open-${root.id}`}
          params={{
            organizationId: scope.organizationId,
            groupId: scope.groupId,
            requestId: root.id,
          }}
          to="/organizations/$organizationId/groups/$groupId/request-queue/$requestId"
        >
          Open
          <span className="sr-only">
            {' '}
            the {SUBTYPE_LABELS[root.subtype]} request on {whenOf(record)}
          </span>
        </Link>
      </td>
    </tr>
  );
}

/**
 * One queued request as a CARD — the same facts, the same controls, the same
 * accessible names as the row.
 *
 * The selection checkbox keeps its per-request accessible name here too: "select
 * this one" is only a choice a person can make if they are told which one it is,
 * and that is as true in a list as in a column.
 */
function QueueCard({
  request,
  isSelected,
  onToggle,
  scope,
}: {
  readonly request: RequestWire;
  readonly isSelected: boolean;
  readonly onToggle: (id: string) => void;
  readonly scope: { organizationId: string; groupId: string };
}): JSX.Element {
  const { root, record } = request;
  return (
    <li
      className="flex min-w-0 flex-col gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-3"
      data-testid={`queue-row-${root.id}`}
    >
      <label className="flex items-start gap-sp-2 text-text">
        <input
          type="checkbox"
          className="mt-sp-1 min-h-target min-w-target"
          data-testid={`select-${root.id}`}
          checked={isSelected}
          onChange={() => onToggle(root.id)}
          aria-label={`Select the ${SUBTYPE_LABELS[root.subtype]} request on ${whenOf(record)} for a batch decision`}
        />
        <span className="font-medium">
          {SUBTYPE_LABELS[root.subtype]} · {whenOf(record)}
        </span>
      </label>
      <p className="text-text">
        <span className="font-mono text-sm">{root.membershipId.slice(0, 8)}</span>
        <span className="sr-only"> membership {root.membershipId}</span>
        {' · '}
        {STATUS_LABELS[root.status]}
        {root.isLate ? <span className="ml-sp-2 text-text-muted">(late)</span> : null}
      </p>
      <Link
        className={SECONDARY_BUTTON_CLASS}
        data-testid={`open-${root.id}`}
        params={{
          organizationId: scope.organizationId,
          groupId: scope.groupId,
          requestId: root.id,
        }}
        to="/organizations/$organizationId/groups/$groupId/request-queue/$requestId"
      >
        Open
        <span className="sr-only">
          {' '}
          the {SUBTYPE_LABELS[root.subtype]} request on {whenOf(record)}
        </span>
      </Link>
    </li>
  );
}

/**
 * Every item's outcome, in the order sent — never a count.
 *
 * `role="status"` rather than `role="alert"`: the batch completed, and a partial
 * result is information rather than an interruption. It is announced, because a
 * scheduler who cannot see the list needs to be told that three of twenty did
 * not go through.
 */
function BatchOutcomes({
  outcomes,
}: {
  readonly outcomes: readonly DecisionItemOutcomeWire[];
}): JSX.Element {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  return (
    <div
      className="rounded-panel border border-border bg-surface-raised p-sp-4"
      role="status"
      aria-live="polite"
      data-testid="batch-outcomes"
    >
      <h3 className="font-semibold text-text">
        {failed.length === 0
          ? `All ${String(outcomes.length)} were decided.`
          : `${String(outcomes.length - failed.length)} of ${String(outcomes.length)} were decided.`}
      </h3>
      <ul className="mt-sp-2 flex flex-col gap-sp-2">
        {outcomes.map((outcome) => (
          <li
            key={outcome.requestId}
            className="text-text"
            data-testid={`outcome-${outcome.requestId}`}
          >
            <span className="font-mono text-sm">{outcome.requestId.slice(0, 8)}</span>{' '}
            {outcome.ok
              ? `— ${STATUS_LABELS[outcome.status]}`
              : `— ${BATCH_FAILURE_WORDING[outcome.failure]}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
