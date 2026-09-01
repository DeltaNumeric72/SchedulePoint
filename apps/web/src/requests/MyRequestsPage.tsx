import type {
  RequestDeadlineWire,
  RequestRecordWire,
  RequestReasonCodeWire,
  RequestWire,
} from '@schedulepoint/contracts';
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
import {
  RequestRefusal,
  attachReasonCode,
  fetchDeadline,
  fetchOwnComments,
  fetchOwnRequests,
  submitRequest,
  withdrawRequest,
} from './api.js';
import {
  REASON_CODES,
  REASON_CODE_LABELS,
  STATUS_LABELS,
  SUBTYPE_HELP,
  SUBTYPE_LABELS,
  isWithdrawable,
} from './vocabulary.js';

/**
 * **A member's own requests — submit, take back, and the status history**
 * (OPUS-M5-005; SPEC-08 §§3–4, doc 42 §5j as amended).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ## I-13, and why "Submit a request…" opens a form
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The control persists nothing. It opens a form with fields to complete and an
 * explicit **Save request**, and opening it issues ZERO requests — the budget
 * `requests-open-submit-form` records the measurement, and it can never be
 * raised without I-13 changing first. Filling the form issues zero as well
 * (`requests-fill-submit-form`), which is the other half of the invariant: a
 * field that fetched or saved on change would put a half-entered absence on the
 * wire.
 *
 * The API makes this structural rather than a promise this component keeps.
 * There is no "create draft" body and no separate submit route: the `draft`
 * status lives inside the server's transaction and is never a state a client has
 * seen or can address. So nothing exists to persist early even if a control
 * tried.
 *
 * ## I-10 — one action, one request
 *
 * Opening the page is two reads that answer two different questions (the
 * deadline, and the member's own requests); saving is one POST plus ONE
 * server-authoritative re-read (PO-DEC-18 — the client re-reads what the server
 * says the list now is rather than patching its own cache and rendering a list
 * no server produced); a REFUSED save re-reads nothing, because nothing changed.
 *
 * ## §3's deadline is shown as a PAIR, and that is the point
 *
 * `nominal` is what the group's policy names and `effective` is where the
 * holiday roll moved it to. A surface showing only the effective date cannot
 * explain why "requests close on the 15th" is displaying the 14th, and that
 * ambiguity is exactly what §3's roll policy exists to remove. A CLOSED window
 * has no date at all and is rendered as having none — inventing one would undo
 * the distinction migration 0010 kept `closed` separate to preserve.
 *
 * ## The comment channel is a CODE PICKER, and there is nowhere to type
 *
 * FAD-58.1. A requester attaches at most one code per turn from the nine, and
 * `other` is TERMINAL — selecting it opens no companion field, here or anywhere,
 * because that field would be the free-text channel under a different name
 * (I-07: no patient-identifying information **or clinical free text**; a length
 * bound bounds size, not kind). I-16: one turn, at most one accepted selection,
 * through one transaction — so the picker submits ONE code and the control is
 * disabled while that turn is in flight.
 *
 * **A reader arriving here asking "how does a doctor say they are ill?" is
 * meeting the ruling, not a gap in it.** They select `personal`, or `other`, and
 * disclose nothing; the scheduler learns the request has a reason and does not
 * learn a diagnosis.
 *
 * ## `revisionRequested` is shown, and only where it MEANS something
 *
 * The flag is R-10's: this request was withdrawn after a published version had
 * honoured it, so a revision was asked for. Migration 0023's guard gives the
 * column exactly one meaning and FAD-55 scopes the edge that sets it to the FIVE
 * non-vacation subtypes — which is every subtype this surface shows. A vacation
 * week's undo is §5.6's `reflected_in_version → reversed` instead, so rendering
 * this flag on a vacation row would be a structural false negative; the vacation
 * round surface accordingly does not render it, and neither does this page,
 * because this page has no vacation rows to render it on.
 *
 * **This is NOT FU-35's consumer.** FU-35 is about "outstanding revision
 * requests" as a UNIFORM QUERY across five subtypes and reversed vacation weeks.
 * What is below is one request's own flag, on its own row, from the read route
 * that already returns it. The distinction was put to the orchestrator before
 * this was built and confirmed; FU-35 stays routed to M5-006.
 *
 * ## CAP-068
 *
 * No third-party host. Every URL this page reaches is same-origin and relative.
 * No font, no icon set, no analytics beacon, no telemetry of any kind.
 */

/**
 * The subtypes this surface can complete a form for TODAY.
 *
 * Three, not five, and the two absentees are a routing fact recorded on screen
 * rather than a narrowing done quietly. `shift-preference` requires a
 * `shiftTypeId` and `shift-group-off` requires a `shiftGroupId`; both catalogue
 * reads are gated on `schedule.catalogue.administer`, which no member holds, so
 * a member has no vocabulary to pick from and the contract will not accept the
 * record without the id. Building a picker out of "shift types that happen to
 * appear on my published schedule" would be incomplete by construction and would
 * quietly redefine what a member may express a preference about.
 *
 * The gap was escalated rather than improvised around, and RULED: the two forms
 * are sequenced into **M5-00D**, whose scope grew from "contacts" to
 * "member-facing directory and vocabulary reads" — the member catalogue read
 * (shift types, and shift groups whose `allow_request` is true; ids and names
 * only) lands there WITH the capability-key decision it needs, as a FAD grounded
 * in doc 08 §6 read at source. It is not amended inline here because inventing a
 * capability key inside a UI packet is rule 11's territory; the M5-001 precedent
 * governs.
 *
 * **This is UI sequencing, not a capability drop.** The submit capability for
 * both subtypes is API-real and shipped (M5-001): the routes accept both records
 * today, and `SUBTYPE_LABELS` below still names all six. What is missing is the
 * member's vocabulary to pick from, and it arrives with M5-00D. The two subtypes
 * stay NAMED here and on screen (rule 3 / rule 11).
 *
 * The option source for both fields is deliberately a single value, so M5-00D's
 * read plugs into one place: add the query, pass its options, and move the two
 * members from `AWAITING_CATALOGUE_READ` into `SUBMITTABLE_HERE`.
 */
const SUBMITTABLE_HERE = ['availability', 'time-off', 'no-call'] as const;
type SubmittableHere = (typeof SUBMITTABLE_HERE)[number];

/** The two the member cannot complete here yet, named rather than dropped. */
const AWAITING_CATALOGUE_READ = ['shift-preference', 'shift-group-off'] as const;

export function MyRequestsPage(): JSX.Element {
  return (
    <RequestsLayout
      title="My requests"
      description="What you have asked for, where each request has got to, and the deadline for asking."
    >
      <MyRequestsPanel />
    </RequestsLayout>
  );
}

function problemsOf(error: unknown): readonly FieldProblem[] {
  if (error instanceof RequestRefusal) return [{ field: 'form', message: error.message }];
  if (error instanceof Error) return [{ field: 'form', message: error.message }];
  return [];
}

/** §3's deadline, both dates, and the closed case as what it is. */
function DeadlinePanel({ deadline }: { readonly deadline: RequestDeadlineWire }): JSX.Element {
  if (deadline.kind === 'closed') {
    return (
      <p
        className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
        data-testid="deadline-closed"
      >
        This group is not accepting requests at the moment.
      </p>
    );
  }
  return (
    <p
      className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
      data-testid="deadline-dated"
    >
      Requests close on <strong>{deadline.effective}</strong>.
      {deadline.rolled ? (
        <span data-testid="deadline-rolled">
          {' '}
          The policy names {deadline.nominal}; it moved to {deadline.effective} because that day is
          not a working day.
        </span>
      ) : null}
    </p>
  );
}

function MyRequestsPanel(): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('submit-request', [
    'subtype',
    'targetDate',
    'rangeStart',
    'rangeEnd',
    'shape',
  ] as const);

  const [open, setOpen] = useState(false);
  const [subtype, setSubtype] = useState<SubmittableHere>('time-off');
  const [shape, setShape] = useState<'single' | 'range'>('single');
  const [targetDate, setTargetDate] = useState('');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const mine = useQuery({
    queryKey: ['own-requests', scope.organizationId, scope.groupId],
    queryFn: () => fetchOwnRequests(scope),
    retry: false,
  });

  const deadline = useQuery({
    queryKey: ['request-deadline', scope.organizationId, scope.groupId],
    queryFn: () => fetchDeadline(scope),
    retry: false,
  });

  /**
   * The record, built from the form.
   *
   * `null` means the form is not complete, and the caller refuses rather than
   * sending a partial body — the contract's union has no half-stated member, so
   * an incomplete range is unrepresentable rather than caught downstream.
   */
  function recordOf(): RequestRecordWire | null {
    if (subtype === 'time-off' && shape === 'range') {
      if (rangeStart === '' || rangeEnd === '') return null;
      return { subtype: 'time-off', rangeStart, rangeEnd };
    }
    if (targetDate === '') return null;
    /* A switch on the literal rather than `{ subtype, targetDate }`, because the
     * contract's union is discriminated: each member fixes `subtype` to ONE
     * literal, so a widened `'availability' | 'time-off' | 'no-call'` matches no
     * member and does not type-check. Spelling the three out is what makes a
     * future sixth subtype a compile error here rather than a silent widening. */
    switch (subtype) {
      case 'availability':
        return { subtype: 'availability', targetDate };
      case 'time-off':
        return { subtype: 'time-off', targetDate };
      case 'no-call':
        return { subtype: 'no-call', targetDate };
    }
  }

  const submit = useMutation({
    mutationFn: () => {
      const record = recordOf();
      if (record === null) throw new Error('The form is not complete.');
      return submitRequest(scope, {
        /* D-7's key, one per attempt at one request. A retry of the SAME attempt
         * replays; a second, deliberate attempt is refused by name with
         * `IDEMPOTENCY_KEY_REUSED` rather than silently replaying something the
         * member did not ask for. Derived from what the request IS, so the same
         * form submitted twice is the same key. */
        idempotencyKey: `req-${subtype}-${targetDate === '' ? `${rangeStart}-${rangeEnd}` : targetDate}`,
        record,
      });
    },
    onSuccess: () => {
      setOpen(false);
      setTargetDate('');
      setRangeStart('');
      setRangeEnd('');
      setProblems([]);
      /* ONE re-read, and the server is the authority on what the list now says
       * (PO-DEC-18). Patching the cache from the response would render a list no
       * server produced — and here it would also invent the new request's
       * VERSION, which the next withdrawal has to present. */
      void queryClient.invalidateQueries({ queryKey: ['own-requests'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const withdraw = useMutation({
    mutationFn: (target: { requestId: string; version: number }) =>
      withdrawRequest(scope, target.requestId, target.version),
    onSuccess: () => {
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['own-requests'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const data = mine.data;

  return (
    <>
      <SurfaceState
        isLoading={deadline.isPending}
        error={deadline.error}
        isEmpty={false}
        emptyMessage="The deadline is not available."
        label="the request deadline"
      >
        {deadline.data === undefined ? null : <DeadlinePanel deadline={deadline.data} />}
      </SurfaceState>

      <section aria-labelledby="submit-heading" className="flex min-w-0 flex-col gap-sp-3">
        <h2 className="text-lg font-semibold text-text" id="submit-heading">
          Ask for something
        </h2>

        <button
          type="button"
          className={PRIMARY_BUTTON_CLASS}
          data-testid="open-submit-form"
          aria-expanded={open}
          onClick={() => {
            /* I-13: this opens a form and writes nothing. The e2e budget for this
             * click is ZERO requests and can never be raised without the
             * invariant changing first. */
            setOpen((value) => !value);
            setProblems([]);
          }}
        >
          {open ? 'Cancel' : 'Submit a request…'}
        </button>

        {open ? (
          <form
            className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
            aria-labelledby="submit-form-heading"
            data-testid="submit-form"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setProblems([]);
              if (recordOf() === null) {
                setProblems([
                  {
                    field:
                      subtype === 'time-off' && shape === 'range' ? 'rangeStart' : 'targetDate',
                    message: 'Enter the date this request is about.',
                  },
                ]);
                return;
              }
              submit.mutate();
            }}
          >
            <h3 className="text-lg font-semibold text-text" id="submit-form-heading">
              Submit a request
            </h3>
            <ValidationSummary problems={problems} fieldIds={fieldIds} formName="submit-request" />

            <Field
              id={fieldIds.subtype}
              label="What are you asking for"
              help={SUBTYPE_HELP[subtype]}
              problem={problems.find((problem) => problem.field === 'subtype')?.message}
            >
              {(attributes) => (
                <select
                  {...attributes}
                  className={CONTROL_CLASS}
                  name="subtype"
                  value={subtype}
                  data-testid="subtype"
                  onChange={(event) => {
                    setSubtype(event.target.value as SubmittableHere);
                    setShape('single');
                  }}
                >
                  {SUBMITTABLE_HERE.map((value) => (
                    <option key={value} value={value}>
                      {SUBTYPE_LABELS[value]}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {subtype === 'time-off' ? (
              <fieldset className="flex flex-col gap-sp-2">
                <legend className="font-medium text-text">One day, or a range</legend>
                {/* A radio pair rather than three optional date fields, because
                    the contract's union has exactly two members and the
                    half-stated range is unrepresentable in it. The control
                    mirrors the shape of the thing it produces. */}
                <div className="flex flex-wrap gap-sp-3">
                  <label className="inline-flex items-center gap-sp-2 text-text">
                    <input
                      type="radio"
                      className="min-h-target min-w-target"
                      name="shape"
                      value="single"
                      data-testid="shape-single"
                      checked={shape === 'single'}
                      onChange={() => setShape('single')}
                    />
                    One day
                  </label>
                  <label className="inline-flex items-center gap-sp-2 text-text">
                    <input
                      type="radio"
                      className="min-h-target min-w-target"
                      name="shape"
                      value="range"
                      data-testid="shape-range"
                      checked={shape === 'range'}
                      onChange={() => setShape('range')}
                    />
                    A range of days
                  </label>
                </div>
              </fieldset>
            ) : null}

            {subtype === 'time-off' && shape === 'range' ? (
              <>
                <Field
                  id={fieldIds.rangeStart}
                  label="First day"
                  problem={problems.find((problem) => problem.field === 'rangeStart')?.message}
                >
                  {(attributes) => (
                    <input
                      {...attributes}
                      type="date"
                      className={CONTROL_CLASS}
                      name="rangeStart"
                      data-testid="range-start"
                      value={rangeStart}
                      onChange={(event) => setRangeStart(event.target.value)}
                    />
                  )}
                </Field>
                <Field
                  id={fieldIds.rangeEnd}
                  label="Last day"
                  help="The last day ends on or after the first."
                  problem={problems.find((problem) => problem.field === 'rangeEnd')?.message}
                >
                  {(attributes) => (
                    <input
                      {...attributes}
                      type="date"
                      className={CONTROL_CLASS}
                      name="rangeEnd"
                      data-testid="range-end"
                      value={rangeEnd}
                      onChange={(event) => setRangeEnd(event.target.value)}
                    />
                  )}
                </Field>
              </>
            ) : (
              <Field
                id={fieldIds.targetDate}
                label="Day"
                problem={problems.find((problem) => problem.field === 'targetDate')?.message}
              >
                {(attributes) => (
                  <input
                    {...attributes}
                    type="date"
                    className={CONTROL_CLASS}
                    name="targetDate"
                    data-testid="target-date"
                    value={targetDate}
                    onChange={(event) => setTargetDate(event.target.value)}
                  />
                )}
              </Field>
            )}

            <button
              type="submit"
              className={PRIMARY_BUTTON_CLASS}
              data-testid="save-request"
              disabled={submit.isPending}
            >
              {submit.isPending ? 'Saving…' : 'Save request'}
            </button>
          </form>
        ) : null}

        {/* Named rather than dropped. A person who came here to express a shift
            preference is told where it went and why, instead of finding a
            surface that silently cannot do it. */}
        <p className="text-sm text-text-muted" data-testid="subtypes-elsewhere">
          {AWAITING_CATALOGUE_READ.map((value) => SUBTYPE_LABELS[value]).join(' and ')} requests
          name a shift type or a shift group, and that vocabulary is not readable from a member
          account yet. They are not available on this screen; they have not been removed from the
          product.
        </p>
        <p className="text-sm text-text-muted" data-testid="vacation-elsewhere">
          {SUBTYPE_LABELS['vacation-selection']} requests are made on the vacation round, where the
          allowance and the weeks in the round are shown.
        </p>
      </section>

      <SurfaceState
        isLoading={mine.isPending}
        error={mine.error}
        isEmpty={data !== undefined && data.requests.length === 0}
        emptyMessage="You have not asked for anything in this group yet."
        label="your requests"
      >
        {data === undefined ? null : (
          <RequestHistory
            requests={data.requests}
            expanded={expanded}
            onExpand={setExpanded}
            onWithdraw={withdraw.mutate}
            problems={problems}
          />
        )}
      </SurfaceState>
    </>
  );
}

/**
 * The member's requests, in the order the server sent them (newest first).
 *
 * A table, because it is tabular: four facts about each of several requests, and
 * a list of paragraphs would make "which of mine were approved" a reading
 * exercise. Every column has a header cell, so a screen reader announces which
 * fact it is reading.
 */
function RequestHistory({
  requests,
  expanded,
  onExpand,
  onWithdraw,
  problems,
}: {
  readonly requests: readonly RequestWire[];
  readonly expanded: string | null;
  readonly onExpand: (id: string | null) => void;
  readonly onWithdraw: (target: { requestId: string; version: number }) => void;
  readonly problems: readonly FieldProblem[];
}): JSX.Element {
  const narrow = useNarrowViewport();
  return (
    <section aria-labelledby="history-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="history-heading">
        Your requests
      </h2>

      {problems.length === 0 ? null : (
        <p
          role="alert"
          className="rounded-panel border border-danger p-sp-3 text-text"
          data-testid="history-problem"
        >
          {problems.map((problem) => problem.message).join(' ')}
        </p>
      )}

      {/* **The list alternative, not a sideways scroll (AC-08, SC 1.4.10).**
          Measured rather than assumed: at 320px this table's min-content width is
          338px, and an `overflow-x-auto` wrapper did NOT keep the page from
          scrolling sideways — hiding the table took the page overflow from 16px
          to 0 while shrinking the wrapper changed nothing. So the house answer
          applies, the one `useNarrowViewport` exists for and `my-schedule` and
          `builds` already use: below 640px the SAME rows render as a list.
          Choosing in JavaScript rather than hiding with CSS keeps exactly one
          representation in the accessibility tree — rendering both would make a
          screen-reader user hear every request twice. The per-row test ids are
          identical in both, because they name the REQUEST, not the markup. */}
      {narrow ? (
        <ul className="flex flex-col gap-sp-2" data-testid="requests">
          {requests.map((request) => (
            <RequestCard
              key={request.root.id}
              request={request}
              isExpanded={expanded === request.root.id}
              onExpand={onExpand}
              onWithdraw={onWithdraw}
            />
          ))}
        </ul>
      ) : (
        <table className="w-full min-w-0 border-collapse text-left" data-testid="requests">
          <caption className="sr-only">Your requests in this group, newest first.</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                What
              </th>
              <th scope="col" className="border-b border-border py-sp-2 pr-sp-3">
                When
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
            {requests.map((request) => (
              <RequestRow
                key={request.root.id}
                request={request}
                isExpanded={expanded === request.root.id}
                onExpand={onExpand}
                onWithdraw={onWithdraw}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * One request as a CARD — the same facts and the same controls as the row.
 *
 * A definition list rather than a paragraph, because the four facts have names
 * and a screen-reader user needs to hear which fact is being read. The status
 * cell's contents — the label, the late marker, R-10's sentence — are shared
 * with the row through `StatusCell`, so the two representations cannot come to
 * say different things about the same request.
 */
function RequestCard({
  request,
  isExpanded,
  onExpand,
  onWithdraw,
}: {
  readonly request: RequestWire;
  readonly isExpanded: boolean;
  readonly onExpand: (id: string | null) => void;
  readonly onWithdraw: (target: { requestId: string; version: number }) => void;
}): JSX.Element {
  const { root, record } = request;
  return (
    <li
      className="flex min-w-0 flex-col gap-sp-2 rounded-panel border border-border bg-surface-raised p-sp-3"
      data-testid={`request-${root.id}`}
    >
      <p className="font-medium text-text">
        {SUBTYPE_LABELS[root.subtype]} · {whenOf(record)}
      </p>
      <p className="text-text" data-testid={`status-${root.id}`}>
        <StatusCell root={root} />
      </p>
      <div className="flex flex-wrap gap-sp-2">
        <RequestActions
          request={request}
          isExpanded={isExpanded}
          onExpand={onExpand}
          onWithdraw={onWithdraw}
        />
      </div>
      {isExpanded ? <RequestDetailPanel requestId={root.id} /> : null}
    </li>
  );
}

/**
 * What a request's status SAYS — written ONCE and rendered by both the table row
 * and the narrow card.
 *
 * Shared rather than duplicated, because two copies of a status renderer are two
 * places for the wording to drift, and the wording is the part that matters:
 * R-10's sentence is spelled out rather than badged, because "revision
 * requested" alone reads as though the published schedule had changed. It has
 * not. The published version is untouched and a revision has been ASKED FOR.
 */
function StatusCell({ root }: { readonly root: RequestWire['root'] }): JSX.Element {
  return (
    <>
      {STATUS_LABELS[root.status]}
      {root.isLate ? <span className="ml-sp-2 text-text-muted">(late)</span> : null}
      {root.revisionRequested ? (
        <span className="ml-sp-2 text-text" data-testid={`revision-${root.id}`}>
          — a published schedule had already used this, so a revision has been asked for
        </span>
      ) : null}
    </>
  );
}

/** The two controls a request offers, shared by the row and the card. */
function RequestActions({
  request,
  isExpanded,
  onExpand,
  onWithdraw,
}: {
  readonly request: RequestWire;
  readonly isExpanded: boolean;
  readonly onExpand: (id: string | null) => void;
  readonly onWithdraw: (target: { requestId: string; version: number }) => void;
}): JSX.Element {
  const { root, record } = request;
  return (
    <>
      <button
        type="button"
        className={SECONDARY_BUTTON_CLASS}
        data-testid={`expand-${root.id}`}
        aria-expanded={isExpanded}
        onClick={() => onExpand(isExpanded ? null : root.id)}
      >
        {isExpanded ? 'Hide detail' : 'Detail'}
        <span className="sr-only">
          {' '}
          for the {SUBTYPE_LABELS[root.subtype]} request on {whenOf(record)}
        </span>
      </button>
      {isWithdrawable(root.status) ? (
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          data-testid={`withdraw-${root.id}`}
          onClick={() =>
            onWithdraw({
              requestId: root.id,
              /* The ROOT's version, guarded server-side, so a stale button in a
               * second tab is refused rather than believed. */
              version: root.version,
            })
          }
        >
          Take back
          <span className="sr-only">
            {' '}
            the {SUBTYPE_LABELS[root.subtype]} request on {whenOf(record)}
          </span>
        </button>
      ) : null}
    </>
  );
}

/** The dates a record is about, said in one string. */
function whenOf(record: RequestRecordWire): string {
  if ('targetDate' in record) return record.targetDate;
  if ('rangeStart' in record) return `${record.rangeStart} to ${record.rangeEnd}`;
  if ('weekStart' in record) return `week of ${record.weekStart}`;
  return '—';
}

function RequestRow({
  request,
  isExpanded,
  onExpand,
  onWithdraw,
}: {
  readonly request: RequestWire;
  readonly isExpanded: boolean;
  readonly onExpand: (id: string | null) => void;
  readonly onWithdraw: (target: { requestId: string; version: number }) => void;
}): JSX.Element {
  const { root, record } = request;
  return (
    <>
      <tr data-testid={`request-${root.id}`}>
        <td className="border-b border-border py-sp-2 pr-sp-3">{SUBTYPE_LABELS[root.subtype]}</td>
        <td className="border-b border-border py-sp-2 pr-sp-3">{whenOf(record)}</td>
        <td className="border-b border-border py-sp-2 pr-sp-3" data-testid={`status-${root.id}`}>
          <StatusCell root={root} />
        </td>
        <td className="border-b border-border py-sp-2">
          <div className="flex flex-wrap gap-sp-2">
            <RequestActions
              request={request}
              isExpanded={isExpanded}
              onExpand={onExpand}
              onWithdraw={onWithdraw}
            />
          </div>
        </td>
      </tr>
      {isExpanded ? (
        <tr>
          <td className="border-b border-border py-sp-3" colSpan={4}>
            <RequestDetailPanel requestId={root.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * One request's reason code and its thread (FAD-58).
 *
 * The thread read happens when the row is EXPANDED — one action, one request
 * (I-10, budget `requests-open-detail`). It is not fetched with the list,
 * because a member opening their request list has not asked for every thread in
 * it, and doing so would make a list of twenty requests cost twenty-one reads.
 */
function RequestDetailPanel({ requestId }: { readonly requestId: string }): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const [code, setCode] = useState<RequestReasonCodeWire | ''>('');
  const [problem, setProblem] = useState<string | null>(null);
  const fieldIds = useFieldIds('reason-code', ['reasonCode'] as const);

  const thread = useQuery({
    queryKey: ['own-comments', scope.organizationId, scope.groupId, requestId],
    queryFn: () => fetchOwnComments(scope, requestId),
    retry: false,
  });

  const attach = useMutation({
    mutationFn: (value: RequestReasonCodeWire) => attachReasonCode(scope, requestId, value),
    onSuccess: () => {
      setCode('');
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: ['own-comments'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof Error ? error.message : 'The reason could not be attached.'),
  });

  return (
    <div className="flex min-w-0 flex-col gap-sp-3">
      <form
        className="flex min-w-0 flex-col gap-sp-2"
        aria-label="Attach a reason"
        data-testid={`reason-form-${requestId}`}
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (code === '') {
            setProblem('Choose a reason.');
            return;
          }
          setProblem(null);
          attach.mutate(code);
        }}
      >
        <Field
          id={fieldIds.reasonCode}
          label="Reason"
          /* The help text says what the vocabulary IS and what it is not, so a
             person does not go looking for a box that does not exist. It does
             not invite elaboration, and there is nothing to elaborate into. */
          help="Choose one. The scheduler sees the reason you choose and nothing else — there is no free-text note on this surface."
          problem={problem ?? undefined}
        >
          {(attributes) => (
            <select
              {...attributes}
              className={CONTROL_CLASS}
              name="reasonCode"
              data-testid={`reason-code-${requestId}`}
              value={code}
              onChange={(event) => setCode(event.target.value as RequestReasonCodeWire | '')}
            >
              <option value="">Choose a reason</option>
              {REASON_CODES.map((value) => (
                <option key={value} value={value}>
                  {REASON_CODE_LABELS[value]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {/* `other` is TERMINAL: selecting it renders NOTHING further. There is no
            branch below this line and there is no field to add one to — that is
            FAD-58.1's load-bearing part, and it is enforced by absence. */}
        <button
          type="submit"
          className={SECONDARY_BUTTON_CLASS}
          data-testid={`attach-reason-${requestId}`}
          /* I-16: one turn, at most one accepted selection. Disabled in flight,
             so an impatient second click cannot become a second accepted code. */
          disabled={attach.isPending || code === ''}
        >
          {attach.isPending ? 'Attaching…' : 'Attach reason'}
        </button>
      </form>

      <SurfaceState
        isLoading={thread.isPending}
        error={thread.error}
        isEmpty={thread.data !== undefined && thread.data.comments.length === 0}
        emptyMessage="Nothing has been said about this request yet."
        label="this request's comments"
      >
        {thread.data === undefined ? null : (
          <ul className="flex flex-col gap-sp-2" data-testid={`thread-${requestId}`}>
            {thread.data.comments.map((comment) => (
              <li key={comment.id} className="rounded-panel border border-border p-sp-3">
                <p className="text-sm text-text-muted">
                  {comment.channel === 'requester' ? 'You' : 'The scheduler'} ·{' '}
                  {comment.createdAt.slice(0, 10)}
                </p>
                <p className="text-text">
                  {/* Exactly one of the two is present on any row — migration
                      0026's two CHECKs make the other impossible — so this reads
                      whichever the channel names rather than guessing. */}
                  {comment.channel === 'requester'
                    ? comment.reasonCode === null
                      ? '—'
                      : REASON_CODE_LABELS[comment.reasonCode]
                    : (comment.body ?? '—')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SurfaceState>
    </div>
  );
}
