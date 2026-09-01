import type { ApprovalWire, RequestDetail, RequestRecordWire } from '@schedulepoint/contracts';
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

import { RequestsLayout, useGroupScope } from './RequestsLayout.js';
import {
  RequestRefusal,
  appendComment,
  approveRequest,
  denyRequest,
  fetchRequestDetail,
  reverseDecision,
} from './api.js';
import { REASON_CODE_LABELS, STATUS_LABELS, SUBTYPE_LABELS } from './vocabulary.js';

/**
 * **One request, its decision history, and the acts a scheduler may perform on
 * it** (OPUS-M5-005; SPEC-08 §4).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ## The decision history is a LIST, and nothing on this page overwrites it
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * §4: a reversal is "a new `approvals` record; the prior decision is never
 * overwritten". So the history renders as a list, oldest to newest, with the
 * reversal SHOWING what it supersedes — a single "current decision" field would
 * be the shape that sentence forbids, and rendering only the latest row would be
 * that shape reintroduced in the display layer.
 *
 * ## Every write is CONDITIONAL, and the version comes from what was read
 *
 * §4: conditional update on `expected_version` — first decision wins, the second
 * gets an explicit conflict, never a silent overwrite. Every button below sends
 * the version this page read, so a second tab open on the same request is
 * REFUSED rather than believed, and the refusal is rendered with its own remedy
 * (`VERSION_CONFLICT` means reload; `REQUEST_OPERATION_ILLEGAL` means somebody
 * already decided it and there is nothing to retry).
 *
 * ## An approval takes no reason; a denial and a reversal require one
 *
 * That asymmetry is the contract's, not this page's: `approveRequestSchema` has
 * one field, and migration 0024's CHECK refuses a reason on an approval from the
 * other side. A reversal requires one for the reason a denial does — it takes
 * back something a person was told they had.
 *
 * ## The scheduler's comment channel is BOUNDED TEXT, and the bound is shown
 *
 * FAD-58.2. Scheduler-authored administrative text of exactly the class
 * `changeSummary`, `overrideReason` and a decision `reason` are — never clinical,
 * never an ingestion path (non-bypass rule 8). The bound is the contract's:
 * 1..1000 AFTER trimming, so a comment of pure whitespace is refused rather than
 * stored. The field states the bound and enforces it honestly rather than
 * clipping silently, because a person who typed 1200 characters needs to be told
 * that, not to have 200 of them disappear.
 *
 * **The two channels are rendered from `channel`, never guessed.** Exactly one
 * of `reasonCode` and `body` is present on any row — migration 0026's two CHECKs
 * make the other impossible — and a requester's row shows the CODE said in
 * words, never a text field, because the requester has none.
 *
 * ## I-10
 *
 * One read on open. Each decision is one write plus ONE server-authoritative
 * re-read (PO-DEC-18): the page re-reads what the server says the request now is
 * rather than patching its own cache, which here would also mean inventing the
 * new version the next act has to present. A refused act re-reads nothing.
 *
 * ## CAP-068 — no third-party host.
 */

export function RequestDetailPage(): JSX.Element {
  return (
    <RequestsLayout
      title="Request"
      description="Everything recorded about this request: what was asked for, every decision ever made about it, and the conversation."
    >
      <DetailPanel />
    </RequestsLayout>
  );
}

function problemsOf(error: unknown): readonly FieldProblem[] {
  if (error instanceof RequestRefusal) return [{ field: 'form', message: error.message }];
  if (error instanceof Error) return [{ field: 'form', message: error.message }];
  return [];
}

function whenOf(record: RequestRecordWire): string {
  if ('targetDate' in record) return record.targetDate;
  if ('rangeStart' in record) return `${record.rangeStart} to ${record.rangeEnd}`;
  if ('weekStart' in record) return `week of ${record.weekStart}`;
  return '—';
}

const DECISION_WORDING: Readonly<Record<ApprovalWire['decision'], string>> = {
  approved: 'Approved',
  denied: 'Not approved',
  reversed: 'Reversed',
};

function DetailPanel(): JSX.Element {
  const scope = useGroupScope();
  const params = useParams({ strict: false }) as { requestId?: string };
  const requestId = params.requestId ?? '';
  const queryClient = useQueryClient();
  const fieldIds = useFieldIds('decision', ['reason', 'comment'] as const);

  const [acting, setActing] = useState<'deny' | 'reverse' | null>(null);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  const detail = useQuery({
    queryKey: ['request-detail', scope.organizationId, scope.groupId, requestId],
    queryFn: () => fetchRequestDetail(scope, requestId),
    retry: false,
  });

  function afterWrite(): void {
    setActing(null);
    setReason('');
    setProblems([]);
    void queryClient.invalidateQueries({ queryKey: ['request-detail'] });
  }

  const approve = useMutation({
    mutationFn: (version: number) => approveRequest(scope, requestId, version),
    onSuccess: afterWrite,
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const deny = useMutation({
    mutationFn: (input: { version: number; reason: string }) =>
      denyRequest(scope, requestId, { expectedVersion: input.version, reason: input.reason }),
    onSuccess: afterWrite,
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const reverse = useMutation({
    mutationFn: (input: { version: number; reason: string }) =>
      reverseDecision(scope, requestId, { expectedVersion: input.version, reason: input.reason }),
    onSuccess: afterWrite,
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const addComment = useMutation({
    mutationFn: (body: string) => appendComment(scope, requestId, body),
    onSuccess: () => {
      setComment('');
      setProblems([]);
      void queryClient.invalidateQueries({ queryKey: ['request-detail'] });
    },
    onError: (error: unknown) => setProblems(problemsOf(error)),
  });

  const data = detail.data;

  return (
    <SurfaceState
      isLoading={detail.isPending}
      error={detail.error}
      isEmpty={data === undefined}
      emptyMessage="This request is not available here."
      label="this request"
    >
      {data === undefined ? null : (
        <>
          <Summary detail={data} />
          <Decisions approvals={data.approvals} />

          <section aria-labelledby="act-heading" className="flex min-w-0 flex-col gap-sp-3">
            <h2 className="text-lg font-semibold text-text" id="act-heading">
              Decide
            </h2>

            <ValidationSummary problems={problems} fieldIds={fieldIds} formName="decision" />

            {acting === null ? (
              <div className="flex flex-wrap gap-sp-2">
                <button
                  type="button"
                  className={PRIMARY_BUTTON_CLASS}
                  data-testid="approve"
                  disabled={approve.isPending}
                  onClick={() => {
                    setProblems([]);
                    approve.mutate(data.request.root.version);
                  }}
                >
                  {approve.isPending ? 'Approving…' : 'Approve'}
                </button>
                <button
                  type="button"
                  className={SECONDARY_BUTTON_CLASS}
                  data-testid="open-deny"
                  onClick={() => {
                    /* I-13: opens a form, decides nothing. A denial needs a
                     * reason, so it cannot be a one-click act. */
                    setProblems([]);
                    setActing('deny');
                  }}
                >
                  Deny…
                </button>
                {data.approvals.some((approval) => approval.decision === 'approved') ? (
                  <button
                    type="button"
                    className={SECONDARY_BUTTON_CLASS}
                    data-testid="open-reverse"
                    onClick={() => {
                      setProblems([]);
                      setActing('reverse');
                    }}
                  >
                    Reverse the approval…
                  </button>
                ) : null}
              </div>
            ) : (
              <form
                className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
                aria-labelledby="reason-form-heading"
                data-testid={acting === 'deny' ? 'deny-form' : 'reverse-form'}
                noValidate
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  if (reason.trim() === '') {
                    setProblems([
                      {
                        field: 'reason',
                        message:
                          acting === 'deny'
                            ? 'A denial says why. Enter a reason.'
                            : 'A reversal says why. Enter a reason.',
                      },
                    ]);
                    return;
                  }
                  setProblems([]);
                  if (acting === 'deny') {
                    deny.mutate({ version: data.request.root.version, reason });
                  } else {
                    reverse.mutate({ version: data.request.root.version, reason });
                  }
                }}
              >
                <h3 className="text-lg font-semibold text-text" id="reason-form-heading">
                  {acting === 'deny' ? 'Deny this request' : 'Reverse this approval'}
                </h3>
                {acting === 'reverse' ? (
                  <p className="text-text" data-testid="reverse-consequence">
                    This takes back something the requester was told they had. The earlier decision
                    is not deleted — a new record is added that names the one it supersedes.
                  </p>
                ) : null}
                <Field
                  id={fieldIds.reason}
                  label="Reason"
                  help="Required. At most 1000 characters. This is recorded on the decision and read back with it."
                  problem={problems.find((problem) => problem.field === 'reason')?.message}
                >
                  {(attributes) => (
                    <textarea
                      {...attributes}
                      className={CONTROL_CLASS}
                      data-testid="decision-reason"
                      maxLength={1000}
                      rows={3}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  )}
                </Field>
                <div className="flex flex-wrap gap-sp-2">
                  <button
                    type="submit"
                    className={PRIMARY_BUTTON_CLASS}
                    data-testid="decision-submit"
                    disabled={deny.isPending || reverse.isPending}
                  >
                    {acting === 'deny' ? 'Deny it' : 'Reverse it'}
                  </button>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON_CLASS}
                    data-testid="decision-cancel"
                    onClick={() => {
                      setActing(null);
                      setReason('');
                      setProblems([]);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </section>

          <Thread
            detail={data}
            comment={comment}
            onComment={setComment}
            onSubmit={() => addComment.mutate(comment)}
            isPending={addComment.isPending}
            fieldId={fieldIds.comment}
            problem={problems.find((problem) => problem.field === 'comment')?.message}
          />
        </>
      )}
    </SurfaceState>
  );
}

function Summary({ detail }: { readonly detail: RequestDetail }): JSX.Element {
  const { root, record } = detail.request;
  return (
    <section aria-labelledby="summary-heading" className="flex min-w-0 flex-col gap-sp-2">
      <h2 className="text-lg font-semibold text-text" id="summary-heading">
        {SUBTYPE_LABELS[root.subtype]} · {whenOf(record)}
      </h2>
      <dl className="flex flex-col gap-sp-1">
        <div className="flex flex-wrap gap-sp-2">
          <dt className="font-medium text-text">Status</dt>
          <dd className="text-text" data-testid="detail-status">
            {STATUS_LABELS[root.status]}
            {root.isLate ? ' (submitted late)' : ''}
          </dd>
        </div>
        <div className="flex flex-wrap gap-sp-2">
          <dt className="font-medium text-text">Requested by</dt>
          <dd className="font-mono text-sm text-text" data-testid="detail-membership">
            {root.membershipId}
          </dd>
        </div>
        <div className="flex flex-wrap gap-sp-2">
          <dt className="font-medium text-text">Decision deadline</dt>
          <dd className="text-text" data-testid="detail-expires">
            {root.expiresAt.slice(0, 10)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** §4's history: every decision ever made, oldest first, nothing overwritten. */
function Decisions({ approvals }: { readonly approvals: readonly ApprovalWire[] }): JSX.Element {
  return (
    <section aria-labelledby="decisions-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="decisions-heading">
        Decision history
      </h2>
      {approvals.length === 0 ? (
        <p className="text-text-muted" data-testid="no-decisions">
          Nobody has decided this yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-sp-2" data-testid="decisions">
          {approvals.map((approval) => (
            <li
              key={approval.id}
              className="rounded-panel border border-border p-sp-3"
              data-testid={`decision-${approval.id}`}
            >
              <p className="font-medium text-text">
                {DECISION_WORDING[approval.decision]}
                {approval.isOverride ? ' — beyond the allowance' : ''}
              </p>
              <p className="text-sm text-text-muted">{approval.decidedAt.slice(0, 10)}</p>
              {approval.supersedesApprovalId === null ? null : (
                <p className="text-sm text-text-muted" data-testid={`supersedes-${approval.id}`}>
                  Supersedes an earlier decision, which is kept.
                </p>
              )}
              {approval.reason === null ? null : (
                <p className="mt-sp-2 text-text">{approval.reason}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Thread({
  detail,
  comment,
  onComment,
  onSubmit,
  isPending,
  fieldId,
  problem,
}: {
  readonly detail: RequestDetail;
  readonly comment: string;
  readonly onComment: (value: string) => void;
  readonly onSubmit: () => void;
  readonly isPending: boolean;
  readonly fieldId: string;
  readonly problem: string | undefined;
}): JSX.Element {
  const remaining = 1000 - comment.trim().length;
  return (
    <section aria-labelledby="thread-heading" className="flex min-w-0 flex-col gap-sp-3">
      <h2 className="text-lg font-semibold text-text" id="thread-heading">
        Comments
      </h2>

      {detail.comments.length === 0 ? (
        <p className="text-text-muted" data-testid="no-comments">
          Nothing has been said about this request yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-sp-2" data-testid="thread">
          {detail.comments.map((entry) => (
            <li
              key={entry.id}
              className="rounded-panel border border-border p-sp-3"
              data-testid={`comment-${entry.id}`}
            >
              <p className="text-sm text-text-muted">
                {entry.channel === 'requester' ? 'The requester' : 'A scheduler'} ·{' '}
                {entry.createdAt.slice(0, 10)}
              </p>
              <p className="text-text">
                {entry.channel === 'requester'
                  ? entry.reasonCode === null
                    ? '—'
                    : /* The requester's half is a CODE said in words. There is no
                         text to render, because there is nowhere for them to type
                         — FAD-58.1, and rendering a field here would be the
                         free-text channel arriving through the display layer. */
                      REASON_CODE_LABELS[entry.reasonCode]
                  : (entry.body ?? '—')}
              </p>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex min-w-0 flex-col gap-sp-2"
        aria-label="Add a comment"
        data-testid="comment-form"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Field
          id={fieldId}
          label="Add a comment"
          help="Between 1 and 1000 characters. This is an administrative note about the request; it is not a message to a patient and it is never part of a notification."
          problem={problem}
        >
          {(attributes) => (
            <textarea
              {...attributes}
              className={CONTROL_CLASS}
              data-testid="comment-body"
              maxLength={1000}
              rows={3}
              value={comment}
              onChange={(event) => onComment(event.target.value)}
            />
          )}
        </Field>
        {/* The bound SURFACED, per the packet: a person is told how much room is
            left rather than discovering the limit by having text vanish. */}
        <p className="text-sm text-text-muted" data-testid="comment-remaining">
          {String(remaining)} characters left.
        </p>
        <button
          type="submit"
          className={SECONDARY_BUTTON_CLASS}
          data-testid="add-comment"
          disabled={isPending || comment.trim() === ''}
        >
          {isPending ? 'Adding…' : 'Add comment'}
        </button>
      </form>
    </section>
  );
}
