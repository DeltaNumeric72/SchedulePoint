import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

import type { GridAssignment, RosterMember } from '@schedulepoint/contracts';

import { ValidationError } from '../api/catalogue.js';
import {
  StaleEditError,
  addAssignment,
  fetchCandidates,
  moveCredit,
  reassignAssignment,
  removeAssignment,
  setPin,
  voidCredit,
  type GroupScope,
} from './api.js';
import {
  CONTROL_CLASS,
  Field,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  ValidationSummary,
  useFieldIds,
  type FieldProblem,
} from '../components/Form.js';
import { decideEligibilityOffer } from './eligibility-offer.js';
import type { CellView } from './grid-model.js';

/**
 * The cell editor — every manual operation on one date × one shift type
 * (OPUS-M3-004).
 *
 * ## Manual is override and recovery (non-bypass rule 7)
 *
 * Assign, remove, reassign, pin, move a credit. Every one is a human editing a
 * DRAFT, every one is audited by the service, and none of them is a scheduling
 * mechanism. There is deliberately no "fill this cell", "auto-assign" or
 * "suggest" control anywhere in this file.
 *
 * ## I-13, and what "before Save" means here
 *
 * Opening a cell issues **zero** requests: the editor renders from the grid the
 * page already holds. Opening the assign picker issues exactly **one** (the
 * candidate read — I-10, one action one request). Typing into any field issues
 * none. Nothing persists until an explicit Save, and each of those three numbers
 * is a budgeted, measured recording.
 *
 * ## Every mutation carries the compare-and-set
 *
 * `expectedCellRevision` is the revision this editor currently believes, seeded
 * from the grid read and replaced by the server's answer after each successful
 * mutation. A `StaleEditError` renders an explicit refetch prompt and blocks
 * further editing until the grid is re-read — never a silent merge, never an
 * automatic retry (PO-DEC-18, SP-E §1.4).
 *
 * ## A removal and a reassignment REQUIRE a reason
 *
 * The service requires one and the audit trail records that one was given. The
 * text itself never enters an audit payload and never comes back on the wire
 * (I-07): what a scheduler typed about a rota decision is theirs, and the audit
 * needs to know only that they justified it.
 */

export interface CellEditorProps {
  readonly scope: GroupScope;
  readonly versionId: string;
  readonly cell: CellView;
  readonly roster: readonly RosterMember[];
  readonly isEditable: boolean;
  readonly onClose: () => void;
  /** Ask the page to re-read the grid — the server is the authority. */
  readonly onMutated: () => void;
}

type PendingAction =
  | { kind: 'none' }
  | { kind: 'assign' }
  | { kind: 'remove'; identityId: string }
  | { kind: 'reassign'; identityId: string }
  | { kind: 'credit'; identityId: string };

export function CellEditor(props: CellEditorProps): JSX.Element {
  const { scope, versionId, cell, roster, isEditable, onClose, onMutated } = props;
  const heading = useRef<HTMLHeadingElement>(null);

  /** The server's latest word on this cell. Seeded from the grid, then replaced. */
  const [assignments, setAssignments] = useState<readonly GridAssignment[]>(cell.assignments);
  const [revision, setRevision] = useState(cell.revision);
  const [pending, setPending] = useState<PendingAction>({ kind: 'none' });
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);

  // Re-seed when the user opens a different cell. Keyed on the cell's identity
  // rather than on object identity, so a grid refetch that produces an equal
  // cell does not discard an open form.
  useEffect(() => {
    setAssignments(cell.assignments);
    setRevision(cell.revision);
    setPending({ kind: 'none' });
    setProblems([]);
    setStaleMessage(null);
    heading.current?.focus();
  }, [cell.date, cell.shiftTypeId, cell.assignments, cell.revision]);

  const nameOf = (membershipId: string): string =>
    roster.find((member) => member.membershipId === membershipId)?.displayName ?? 'Unknown member';

  /** One place every mutation result and every refusal is handled. */
  const applyResult = (result: { cell: { assignments: GridAssignment[]; revision: string } }): void => {
    setAssignments(result.cell.assignments);
    setRevision(result.cell.revision);
    setPending({ kind: 'none' });
    setProblems([]);
    setStaleMessage(null);
    onMutated();
  };

  const handleError = (error: unknown): void => {
    if (error instanceof StaleEditError) {
      // Explicit refusal. Nothing is merged and nothing is retried; the user is
      // told, and the grid must be re-read before another edit is accepted.
      setStaleMessage(error.message);
      setProblems([]);
      return;
    }
    setStaleMessage(null);
    setProblems(error instanceof ValidationError ? error.problems : []);
  };

  return (
    <section
      aria-labelledby="cell-editor-heading"
      className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface-raised p-sp-4"
      data-testid="cell-editor"
    >
      <div className="flex flex-wrap items-center justify-between gap-sp-3">
        <h2
          className="text-lg font-semibold text-text"
          id="cell-editor-heading"
          ref={heading}
          tabIndex={-1}
        >
          {cell.shiftTypeCode} on {cell.date}
        </h2>
        <button
          className={SECONDARY_BUTTON_CLASS}
          data-testid="cell-editor-close"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>

      <p className="text-sm text-text-muted" data-testid="cell-editor-demand">
        {String(cell.filledCount)} assigned of {String(cell.requiredCount)} required.
        {cell.isIncomplete ? ' This requirement is not met.' : ''}
        {cell.isOverfilled ? ' More people are assigned than the requirement asks for.' : ''}
      </p>

      {isEditable ? null : (
        <p
          className="rounded-panel border border-border bg-surface p-sp-3 text-text"
          data-testid="cell-editor-readonly"
        >
          This version is not a draft, so its content cannot be changed. To amend it, clone it into
          a new draft and publish forward.
        </p>
      )}

      {staleMessage === null ? null : (
        <div
          className="rounded-panel border border-danger bg-surface p-sp-3"
          data-testid="cell-editor-stale"
          role="alert"
        >
          <p className="font-semibold text-danger">{staleMessage}</p>
          <p className="mt-sp-2 text-text">
            Your change was not applied. Reload this cell to see what the schedule now says, then
            decide again.
          </p>
          <p className="mt-sp-3">
            <button
              className={PRIMARY_BUTTON_CLASS}
              data-testid="cell-editor-refetch"
              onClick={() => {
                setStaleMessage(null);
                onMutated();
              }}
              type="button"
            >
              Reload this cell
            </button>
          </p>
        </div>
      )}

      <AssignmentList
        assignments={assignments}
        isEditable={isEditable && staleMessage === null}
        nameOf={nameOf}
        onAct={(action) => {
          setProblems([]);
          setPending(action);
        }}
        onPin={(identityId, isPinned) =>
          setPin(scope, versionId, identityId, { isPinned, expectedCellRevision: revision })
            .then(applyResult)
            .catch(handleError)
        }
        onVoidCredit={(creditId) =>
          voidCredit(scope, versionId, creditId, revision).then(applyResult).catch(handleError)
        }
      />

      {pending.kind === 'remove' ? (
        <ReasonForm
          formName="remove"
          heading="Remove this assignment"
          help="The assignment is cancelled, not deleted — the draft keeps the record that it was there."
          label="Why is it being removed?"
          onCancel={() => setPending({ kind: 'none' })}
          onSave={(reason) =>
            removeAssignment(scope, versionId, pending.identityId, {
              reason,
              expectedCellRevision: revision,
            })
              .then(applyResult)
              .catch(handleError)
          }
          problems={problems}
        />
      ) : null}

      {pending.kind === 'reassign' ? (
        <MemberReasonForm
          formName="reassign"
          heading="Reassign this shift"
          help="The assignment keeps its identity, so the change reads as a move rather than as a deletion and an unrelated addition."
          memberLabel="Assign instead to"
          onCancel={() => setPending({ kind: 'none' })}
          onSave={(membershipId, reason) =>
            reassignAssignment(scope, versionId, pending.identityId, {
              toMembershipId: membershipId,
              reason,
              expectedCellRevision: revision,
            })
              .then(applyResult)
              .catch(handleError)
          }
          problems={problems}
          roster={roster}
        />
      ) : null}

      {pending.kind === 'credit' ? (
        <MemberReasonForm
          formName="credit"
          heading="Move the credit"
          help="Who works a shift and who is scored for it can legitimately differ. Moving a credit never changes who is assigned, and it is only possible on a draft."
          memberLabel="Credit instead to"
          onCancel={() => setPending({ kind: 'none' })}
          onSave={(membershipId, reason) =>
            moveCredit(scope, versionId, pending.identityId, {
              creditedMembershipId: membershipId,
              reason,
              expectedCellRevision: revision,
            })
              .then(applyResult)
              .catch(handleError)
          }
          problems={problems}
          roster={roster}
        />
      ) : null}

      {isEditable && staleMessage === null && pending.kind === 'none' ? (
        <p>
          <button
            className={PRIMARY_BUTTON_CLASS}
            data-testid="cell-assign-open"
            onClick={() => {
              // I-13: local state. The candidate read happens inside the picker,
              // as one request for one action.
              setProblems([]);
              setPending({ kind: 'assign' });
            }}
            type="button"
          >
            Assign someone
          </button>
        </p>
      ) : null}

      {pending.kind === 'assign' ? (
        <AssignPicker
          cell={cell}
          onCancel={() => setPending({ kind: 'none' })}
          onSave={(membershipId, overrideReason) =>
            addAssignment(scope, versionId, {
              date: cell.date,
              shiftTypeId: cell.shiftTypeId,
              membershipId,
              ...(overrideReason === null ? {} : { overrideReason }),
              expectedCellRevision: revision,
            })
              .then(applyResult)
              .catch(handleError)
          }
          problems={problems}
          scope={scope}
          versionId={versionId}
        />
      ) : null}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * What is already in the cell — provenance is visible without opening anything
 * ──────────────────────────────────────────────────────────────────────────── */

function AssignmentList({
  assignments,
  isEditable,
  nameOf,
  onAct,
  onPin,
  onVoidCredit,
}: {
  assignments: readonly GridAssignment[];
  isEditable: boolean;
  nameOf: (membershipId: string) => string;
  onAct: (action: PendingAction) => void;
  onPin: (identityId: string, isPinned: boolean) => Promise<void>;
  onVoidCredit: (creditId: string) => Promise<void>;
}): JSX.Element {
  if (assignments.length === 0) {
    return (
      <p className="text-text-muted" data-testid="cell-editor-empty">
        Nobody is assigned to this shift yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-sp-3" data-testid="cell-assignments">
      {assignments.map((assignment) => (
        <li
          className="rounded-panel border border-border bg-surface p-sp-3"
          data-testid={`cell-assignment-${assignment.assignmentIdentityId}`}
          key={assignment.assignmentIdentityId}
        >
          <h3 className="font-semibold text-text">{nameOf(assignment.membershipId)}</h3>

          {/* Provenance, as a definition list: where the assignment came from,
              whether it is pinned, whether a human overrode something, and where
              the credit went. All words — never colour alone. */}
          <dl className="mt-sp-2 flex flex-col gap-sp-1 text-sm">
            <div className="flex gap-sp-2">
              <dt className="text-text-muted">Origin</dt>
              <dd className="text-text" data-testid="assignment-origin">
                {assignment.origin === 'manual'
                  ? 'Added by hand'
                  : assignment.origin === 'clone'
                    ? 'Copied from an earlier version'
                    : assignment.origin}
              </dd>
            </div>
            <div className="flex gap-sp-2">
              <dt className="text-text-muted">Pinned</dt>
              <dd className="text-text">
                {assignment.isPinned
                  ? 'Yes — a later automated build may not move it'
                  : 'No'}
              </dd>
            </div>
            <div className="flex gap-sp-2">
              <dt className="text-text-muted">Override</dt>
              <dd className="text-text">
                {assignment.overrideReasonGiven ? 'A reason was recorded' : 'None'}
              </dd>
            </div>
            <div className="flex gap-sp-2">
              <dt className="text-text-muted">Credit</dt>
              <dd className="text-text" data-testid="assignment-credit">
                {assignment.creditedMembershipId === null
                  ? 'With the assignee'
                  : `Moved to ${nameOf(assignment.creditedMembershipId)}${
                      assignment.creditStatus === 'voided' ? ' (voided)' : ''
                    }`}
              </dd>
            </div>
          </dl>

          {isEditable ? (
            <div className="mt-sp-3 flex flex-wrap gap-sp-2">
              <button
                className={SECONDARY_BUTTON_CLASS}
                data-testid={`cell-pin-${assignment.assignmentIdentityId}`}
                onClick={() => {
                  void onPin(assignment.assignmentIdentityId, !assignment.isPinned);
                }}
                type="button"
              >
                {assignment.isPinned ? 'Unpin' : 'Pin'}
                <span className="sr-only"> {nameOf(assignment.membershipId)}</span>
              </button>
              <button
                className={SECONDARY_BUTTON_CLASS}
                data-testid={`cell-reassign-${assignment.assignmentIdentityId}`}
                onClick={() =>
                  onAct({ kind: 'reassign', identityId: assignment.assignmentIdentityId })
                }
                type="button"
              >
                Reassign
                <span className="sr-only"> {nameOf(assignment.membershipId)}</span>
              </button>
              <button
                className={SECONDARY_BUTTON_CLASS}
                data-testid={`cell-credit-${assignment.assignmentIdentityId}`}
                onClick={() =>
                  onAct({ kind: 'credit', identityId: assignment.assignmentIdentityId })
                }
                type="button"
              >
                Move credit
                <span className="sr-only"> for {nameOf(assignment.membershipId)}</span>
              </button>
              {assignment.creditId === null || assignment.creditStatus === 'voided' ? null : (
                <button
                  className={SECONDARY_BUTTON_CLASS}
                  data-testid={`cell-void-credit-${assignment.assignmentIdentityId}`}
                  onClick={() => {
                    void onVoidCredit(assignment.creditId ?? '');
                  }}
                  type="button"
                >
                  Void credit
                  <span className="sr-only"> for {nameOf(assignment.membershipId)}</span>
                </button>
              )}
              <button
                className={SECONDARY_BUTTON_CLASS}
                data-testid={`cell-remove-${assignment.assignmentIdentityId}`}
                onClick={() =>
                  onAct({ kind: 'remove', identityId: assignment.assignmentIdentityId })
                }
                type="button"
              >
                Remove
                <span className="sr-only"> {nameOf(assignment.membershipId)}</span>
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * The assign picker — where the eligibility ruling is rendered
 * ──────────────────────────────────────────────────────────────────────────── */

function AssignPicker({
  cell,
  onCancel,
  onSave,
  problems,
  scope,
  versionId,
}: {
  cell: CellView;
  onCancel: () => void;
  onSave: (membershipId: string, overrideReason: string | null) => Promise<void>;
  problems: readonly FieldProblem[];
  scope: GroupScope;
  versionId: string;
}): JSX.Element {
  const fieldIds = useFieldIds('assign', ['membershipId', 'overrideReason'] as const);
  const [membershipId, setMembershipId] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  const candidates = useQuery({
    queryKey: ['schedule-candidates', versionId, cell.date, cell.shiftTypeId],
    queryFn: () => fetchCandidates(scope, versionId, cell),
    retry: false,
  });

  const save = useMutation({
    mutationFn: () =>
      onSave(membershipId, overrideReason.trim() === '' ? null : overrideReason.trim()),
  });

  // The ruling, applied in one call. Everything below renders what it returns.
  const offer =
    candidates.data === undefined
      ? null
      : decideEligibilityOffer(candidates.data);
  const chosen = offer?.offers.find((entry) => entry.candidate.membershipId === membershipId);

  return (
    <form
      className="flex flex-col gap-sp-4 rounded-panel border border-border bg-surface p-sp-3"
      data-testid="cell-assign-form"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold text-text">Assign someone to this shift</h3>
      <ValidationSummary problems={problems} fieldIds={fieldIds} formName="assign" />

      {candidates.isPending ? (
        <p aria-live="polite" data-testid="candidates-loading" role="status">
          Loading who can be assigned…
        </p>
      ) : null}

      {candidates.error !== null && candidates.error !== undefined ? (
        <p className="text-danger" data-testid="candidates-error" role="alert">
          The list of people could not be loaded.
        </p>
      ) : null}

      {offer?.notice === null || offer?.notice === undefined ? null : (
        /* ABSENT and NONE-ELIGIBLE are DIFFERENT sentences, deliberately. The
           test asserts which one appears, so collapsing them would fail. */
        <p
          className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
          data-testid={offer.eligibilityAbsent ? 'eligibility-absent' : 'eligibility-none'}
          role="status"
        >
          {offer.notice}
        </p>
      )}

      {offer === null ? null : (
        <Field
          id={fieldIds.membershipId}
          label="Person"
          help="Everyone in the group is listed. What is shown beside a name is what the server could tell this account."
          problem={problemFor(problems, 'membershipId')}
        >
          {(attributes) => (
            <select
              {...attributes}
              className={CONTROL_CLASS}
              data-testid="candidate-select"
              onChange={(event) => setMembershipId(event.target.value)}
              value={membershipId}
            >
              <option value="">Choose a person</option>
              {offer.offers.map((entry) => (
                <option
                  data-disposition={entry.disposition}
                  key={entry.candidate.membershipId}
                  value={entry.candidate.membershipId}
                >
                  {entry.candidate.displayName} — {entry.label}
                  {entry.candidate.alreadyAssigned ? ' — already on this shift' : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {/* A reason is REQUIRED only for a known ineligibility. An unknown one has
          nothing to override, and demanding a justification for it would train
          schedulers to type "n/a" into an audit-bearing field. */}
      <Field
        id={fieldIds.overrideReason}
        label={
          chosen?.requiresOverrideReason === true
            ? 'Why are you overriding the credential requirement?'
            : 'Reason (optional)'
        }
        help="Administrative note about this rota decision. It is never shown in the schedule and never enters an audit payload."
        problem={problemFor(problems, 'overrideReason')}
      >
        {(attributes) => (
          <input
            {...attributes}
            className={CONTROL_CLASS}
            data-testid="assign-reason"
            onChange={(event) => setOverrideReason(event.target.value)}
            type="text"
            value={overrideReason}
          />
        )}
      </Field>

      {/* The reason is REQUIRED for a known ineligibility, and the interface says
          so rather than letting the server refuse a form that looked complete.
          The note is always rendered in that arm, so a screen-reader user meets
          the requirement before the disabled control rather than after it. */}
      {chosen?.requiresOverrideReason === true && overrideReason.trim() === '' ? (
        <p className="text-danger" data-testid="assign-reason-required" id={`${fieldIds.overrideReason}-required`}>
          A reason is required before this assignment can be saved: this person does not hold every
          credential the shift type requires.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-sp-3">
        <button
          aria-describedby={
            chosen?.requiresOverrideReason === true && overrideReason.trim() === ''
              ? `${fieldIds.overrideReason}-required`
              : undefined
          }
          className={PRIMARY_BUTTON_CLASS}
          data-testid="cell-assign-save"
          disabled={chosen?.requiresOverrideReason === true && overrideReason.trim() === ''}
          type="submit"
        >
          Save assignment
        </button>
        <button className={SECONDARY_BUTTON_CLASS} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * The two small forms
 * ──────────────────────────────────────────────────────────────────────────── */

function ReasonForm({
  formName,
  heading,
  help,
  label,
  onCancel,
  onSave,
  problems,
}: {
  formName: string;
  heading: string;
  help: string;
  label: string;
  onCancel: () => void;
  onSave: (reason: string) => Promise<void>;
  problems: readonly FieldProblem[];
}): JSX.Element {
  const fieldIds = useFieldIds(formName, ['reason'] as const);
  const [reason, setReason] = useState('');

  return (
    <form
      className="flex flex-col gap-sp-3 rounded-panel border border-border bg-surface p-sp-3"
      data-testid={`cell-${formName}-form`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(reason);
      }}
    >
      <h3 className="font-semibold text-text">{heading}</h3>
      <ValidationSummary problems={problems} fieldIds={fieldIds} formName={formName} />
      <Field id={fieldIds.reason} label={label} help={help} problem={problemFor(problems, 'reason')}>
        {(attributes) => (
          <input
            {...attributes}
            className={CONTROL_CLASS}
            onChange={(event) => setReason(event.target.value)}
            type="text"
            value={reason}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-sp-3">
        <button className={PRIMARY_BUTTON_CLASS} data-testid={`cell-${formName}-save`} type="submit">
          Save
        </button>
        <button className={SECONDARY_BUTTON_CLASS} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}

function MemberReasonForm({
  formName,
  heading,
  help,
  memberLabel,
  onCancel,
  onSave,
  problems,
  roster,
}: {
  formName: string;
  heading: string;
  help: string;
  memberLabel: string;
  onCancel: () => void;
  onSave: (membershipId: string, reason: string) => Promise<void>;
  problems: readonly FieldProblem[];
  roster: readonly RosterMember[];
}): JSX.Element {
  const fieldIds = useFieldIds(formName, ['membershipId', 'reason'] as const);
  const [membershipId, setMembershipId] = useState('');
  const [reason, setReason] = useState('');

  return (
    <form
      className="flex flex-col gap-sp-3 rounded-panel border border-border bg-surface p-sp-3"
      data-testid={`cell-${formName}-form`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(membershipId, reason);
      }}
    >
      <h3 className="font-semibold text-text">{heading}</h3>
      <ValidationSummary problems={problems} fieldIds={fieldIds} formName={formName} />
      <Field
        id={fieldIds.membershipId}
        label={memberLabel}
        help={help}
        problem={problemFor(problems, 'membershipId')}
      >
        {(attributes) => (
          <select
            {...attributes}
            className={CONTROL_CLASS}
            data-testid={`cell-${formName}-member`}
            onChange={(event) => setMembershipId(event.target.value)}
            value={membershipId}
          >
            <option value="">Choose a person</option>
            {roster.map((member) => (
              <option key={member.membershipId} value={member.membershipId}>
                {member.displayName}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        id={fieldIds.reason}
        label="Reason"
        help="Recorded as given. The text itself never enters an audit payload."
        problem={problemFor(problems, 'reason')}
      >
        {(attributes) => (
          <input
            {...attributes}
            className={CONTROL_CLASS}
            onChange={(event) => setReason(event.target.value)}
            type="text"
            value={reason}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-sp-3">
        <button className={PRIMARY_BUTTON_CLASS} data-testid={`cell-${formName}-save`} type="submit">
          Save
        </button>
        <button className={SECONDARY_BUTTON_CLASS} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}

function problemFor(problems: readonly FieldProblem[], field: string): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}
