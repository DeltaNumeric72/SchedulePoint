import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState, type FormEvent, type JSX } from 'react';
import {
  publicationConfirmationPhrase,
  publicationPhraseMatches,
  type PublishedVersionView,
  type PublishResultWire,
  type VersionHistory,
} from '@schedulepoint/contracts';

import { ApiError } from '../api/client.js';
import { ValidationError } from '../api/catalogue.js';
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
import { SurfaceState, isPermissionDenied } from '../components/SurfaceState.js';
import { useNarrowViewport } from '../components/useNarrowViewport.js';
import {
  CurrentVersionMovedError,
  cloneForCorrection,
  fetchVersionHistory,
  revertPeriod,
} from './api.js';
import { PublicationLayout, publicationSections } from './PublicationLayout.js';
import { useRetainedIdempotencyKey } from './idempotency.js';

/**
 * Version history: immutable, readable, and never editable (OPUS-M3-005).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## The one property this screen exists to make true
 *
 * > I-18 / non-bypass rule 5: **never mutate a published version.** Amend by
 * > publishing forward; supersession never deletes history.
 *
 * A published or superseded version is frozen in the database (D-15a's triggers)
 * and refused by the frozen service (`assertEditable`). This screen is the third
 * place the same rule has to hold — the one a human actually meets — and it
 * holds by construction: **no control that edits a version is rendered inside an
 * immutable row.**
 *
 * That is asserted rather than asserted-about. Every row carries
 * `data-immutable`, and every control inside a row declares what it does:
 *
 * | `data-affordance` | Meaning |
 * |---|---|
 * | `edit` | opens THIS version for editing. Rendered only where `data-immutable="false"` |
 * | `read` | compares or views. Changes nothing |
 * | `derive` | creates a NEW version from this one — a clone, or a revert that publishes forward. Never writes to the row it started from |
 *
 * `apps/web/e2e/publication.spec.ts` asserts that no `data-affordance="edit"`
 * control exists in any immutable row, and — so the assertion is not vacuous —
 * that a draft row does have one.
 *
 * ## Two ways forward from history, and neither is an edit
 *
 *  - **Clone into a new draft** (forward correction, SPEC-05 §6.1): copies the
 *    content into a fresh draft, preserving assignment identity so the eventual
 *    difference is a real diff rather than "everything removed and re-added".
 *    The published version is read and never written. The screen then hands off
 *    to the authoring surface by link, rather than navigating on its own — the
 *    user decides when to leave.
 *  - **Revert to this version**: clones it forward, approves it and publishes
 *    it, so reverting to v3 creates v5 with v3's content. Deleting v4 would erase
 *    the fact that it happened, so nothing is deleted. It is grant-only and
 *    carries its own typed confirmation, because it changes a live schedule.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function VersionHistoryPage(): JSX.Element {
  const scope = useGroupScope();
  const params = useParams({ strict: false }) as { periodId?: string };
  const periodId = params.periodId ?? '';

  const history = useQuery({
    queryKey: ['publication-history', scope.organizationId, scope.groupId, periodId],
    queryFn: () => fetchVersionHistory(scope, periodId),
    retry: false,
  });

  return (
    <PublicationLayout
      description="Every version of this period, newest first. Published and superseded versions are permanent records — they are readable and can be compared, and nothing here can change them."
      sections={publicationSections(scope, periodId, 'history')}
      title="Version history"
    >
      <SurfaceState
        isLoading={history.isPending}
        error={history.error}
        isEmpty={history.data !== undefined && history.data.versions.length === 0}
        emptyMessage="This period has no versions yet. Create a draft on the authoring surface to begin."
        label="the version history"
      >
        {history.data === undefined ? null : (
          <HistoryPanel history={history.data} periodId={periodId} />
        )}
      </SurfaceState>
    </PublicationLayout>
  );
}

function stateLabel(version: PublishedVersionView): string {
  if (version.state === 'published') return 'Published — this is what staff are working to';
  if (version.state === 'superseded') return 'Superseded — replaced by a later publication';
  if (version.state === 'cancelled') return 'Cancelled';
  if (version.state === 'approved') return 'Approved — ready to publish';
  if (version.state === 'in_review') return 'In review';
  if (version.state === 'publishing') return 'Publishing';
  return version.lockState === 'locked' ? 'Draft — locked for editing' : 'Draft';
}

function versionLabel(version: PublishedVersionView): string {
  return version.versionNumber === null
    ? 'Unpublished draft'
    : `Version ${String(version.versionNumber)}`;
}

function HistoryPanel({
  history,
  periodId,
}: {
  history: VersionHistory;
  periodId: string;
}): JSX.Element {
  const scope = useGroupScope();
  const narrow = useNarrowViewport();
  const [revertTarget, setRevertTarget] = useState<PublishedVersionView | null>(null);
  const [cloneTarget, setCloneTarget] = useState<PublishedVersionView | null>(null);

  const base = `/organizations/${scope.organizationId}/groups/${scope.groupId}`;

  const rowControls = (version: PublishedVersionView): JSX.Element => (
    <div className="flex flex-wrap gap-sp-2">
      <a
        className={SECONDARY_BUTTON_CLASS}
        data-affordance="read"
        data-testid={`compare-${version.id}`}
        href={`${base}/publication/versions/${version.id}/comparison`}
      >
        Compare<span className="sr-only"> {versionLabel(version)} with what it replaced</span>
      </a>

      {version.isEditable ? (
        <a
          className={SECONDARY_BUTTON_CLASS}
          data-affordance="edit"
          data-testid={`edit-${version.id}`}
          href={`${base}/schedule/versions/${version.id}`}
        >
          Edit this draft
        </a>
      ) : null}

      {version.state === 'approved' && history.canPublish ? (
        <a
          className={PRIMARY_BUTTON_CLASS}
          data-affordance="read"
          data-testid={`review-${version.id}`}
          href={`${base}/publication/versions/${version.id}/review`}
        >
          Review and publish
        </a>
      ) : null}

      {version.isImmutable ? (
        <button
          className={SECONDARY_BUTTON_CLASS}
          data-affordance="derive"
          data-testid={`clone-${version.id}`}
          onClick={() => {
            // I-13: local state only. Nothing is created, nothing is fetched.
            setCloneTarget(version);
            setRevertTarget(null);
          }}
          type="button"
        >
          Clone into a new draft…
        </button>
      ) : null}

      {version.isImmutable && !version.isCurrent && history.canRevert ? (
        <button
          className={SECONDARY_BUTTON_CLASS}
          data-affordance="derive"
          data-testid={`revert-${version.id}`}
          onClick={() => {
            setRevertTarget(version);
            setCloneTarget(null);
          }}
          type="button"
        >
          Revert to this version…
        </button>
      ) : null}
    </div>
  );

  const rowFacts = (version: PublishedVersionView): JSX.Element => (
    <dl className="flex flex-col gap-sp-1 text-sm">
      <div className="flex gap-sp-2">
        <dt className="text-text-muted">State</dt>
        <dd className="text-text" data-testid={`state-${version.id}`}>
          {stateLabel(version)}
        </dd>
      </div>
      <div className="flex gap-sp-2">
        <dt className="text-text-muted">Assignments</dt>
        <dd className="text-text">{version.activeAssignmentCount}</dd>
      </div>
      {version.publishedAt === null ? null : (
        <div className="flex gap-sp-2">
          <dt className="text-text-muted">Published</dt>
          <dd className="text-text">
            {version.publishedAt} by {version.publishedByDisplayName ?? 'a member no longer listed'}
          </dd>
        </div>
      )}
      {version.supersededAt === null ? null : (
        <div className="flex gap-sp-2">
          <dt className="text-text-muted">Superseded</dt>
          <dd className="text-text">{version.supersededAt}</dd>
        </div>
      )}
    </dl>
  );

  return (
    <div className="flex min-w-0 flex-col gap-sp-5">
      <p className="text-text" data-testid="history-immutability-legend">
        Versions marked <strong>published</strong> or <strong>superseded</strong> are permanent. They
        can be read, compared and used as the source of a new draft; they cannot be edited, and no
        control on this page edits one.
      </p>

      <section aria-labelledby="history-versions-heading" className="flex min-w-0 flex-col gap-sp-3">
        {/* The heading is not decoration: the rows below are `h3`, and a jump
            from the page `h1` to an `h3` is a heading-order defect axe catches. */}
        <h2 className="text-lg font-semibold text-text" id="history-versions-heading">
          Versions
        </h2>

      {narrow ? (
        <ul className="flex flex-col gap-sp-3" data-testid="history-list">
          {history.versions.map((version) => (
            <li
              className="rounded-panel border border-border bg-surface-raised p-sp-3"
              data-immutable={String(version.isImmutable)}
              data-testid={`version-row-${version.id}`}
              key={version.id}
            >
              <h3 className="font-semibold text-text">{versionLabel(version)}</h3>
              <div className="mt-sp-2">{rowFacts(version)}</div>
              <div className="mt-sp-3">{rowControls(version)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="min-w-0 overflow-x-auto" tabIndex={0}>
          <table className="w-full border-collapse text-left" data-testid="history-table">
            <caption className="sr-only">
              Every version of this period, newest first, with what can be done with each
            </caption>
            <thead>
              <tr>
                <th className="border-b border-border p-sp-2" scope="col">
                  Version
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  State
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  Assignments
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  Published
                </th>
                <th className="border-b border-border p-sp-2" scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {history.versions.map((version) => (
                <tr
                  data-immutable={String(version.isImmutable)}
                  data-testid={`version-row-${version.id}`}
                  key={version.id}
                >
                  <th className="border-b border-border p-sp-2 font-medium text-text" scope="row">
                    {versionLabel(version)}
                  </th>
                  <td className="border-b border-border p-sp-2 text-text" data-testid={`state-${version.id}`}>
                    {stateLabel(version)}
                  </td>
                  <td className="border-b border-border p-sp-2 text-text">
                    {version.activeAssignmentCount}
                  </td>
                  <td className="border-b border-border p-sp-2 text-text">
                    {version.publishedAt === null
                      ? '—'
                      : `${version.publishedAt} by ${
                          version.publishedByDisplayName ?? 'a member no longer listed'
                        }`}
                  </td>
                  <td className="border-b border-border p-sp-2">{rowControls(version)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </section>

      {cloneTarget === null ? null : (
        <CloneForwardPanel
          onClose={() => setCloneTarget(null)}
          periodId={periodId}
          version={cloneTarget}
        />
      )}

      {revertTarget === null ? null : (
        <RevertPanel
          history={history}
          onClose={() => setRevertTarget(null)}
          periodId={periodId}
          version={revertTarget}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Forward correction — clone, then hand off to the authoring surface
 * ──────────────────────────────────────────────────────────────────────────── */

function CloneForwardPanel({
  version,
  periodId,
  onClose,
}: {
  version: PublishedVersionView;
  periodId: string;
  onClose: () => void;
}): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const clone = useMutation({
    mutationFn: () => cloneForCorrection(scope, version.id),
    onSuccess: (result) => {
      setCreated(result.version.id);
      void queryClient.invalidateQueries({ queryKey: ['publication-history'] });
    },
    onError: (error: unknown) => {
      setFailure(
        error instanceof ApiError
          ? isPermissionDenied(error)
            ? 'You do not have permission to author drafts in this group.'
            : error.message
          : 'The draft could not be created.',
      );
    },
  });

  return (
    <section
      aria-labelledby="clone-heading"
      className="flex flex-col gap-sp-3 rounded-panel border border-border bg-surface-raised p-sp-4"
      data-testid="clone-panel"
    >
      <h2 className="text-lg font-semibold text-text" id="clone-heading">
        Correct {versionLabel(version)} by publishing forward
      </h2>
      <p className="text-text">
        This copies the content of {versionLabel(version)} into a <strong>new draft</strong>. The
        published version is not touched and stays in the history exactly as it is. Edit the draft on
        the authoring surface, then come back here to review and publish it.
      </p>

      {failure === null ? null : (
        <p className="rounded-panel border border-danger p-sp-3 text-text" role="alert" data-testid="clone-failed">
          {failure}
        </p>
      )}

      {created === null ? (
        <div className="flex flex-wrap gap-sp-2">
          <button
            className={PRIMARY_BUTTON_CLASS}
            data-testid="clone-confirm"
            disabled={clone.isPending}
            onClick={() => clone.mutate()}
            type="button"
          >
            {clone.isPending ? 'Creating the draft…' : 'Create the draft'}
          </button>
          <button
            className={SECONDARY_BUTTON_CLASS}
            data-testid="clone-cancel"
            disabled={clone.isPending}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div data-testid="clone-created" role="status">
          <p className="font-semibold text-text">The draft was created.</p>
          <p className="mt-sp-2">
            <a
              className={PRIMARY_BUTTON_CLASS}
              data-affordance="edit"
              data-testid="clone-open-draft"
              href={`/organizations/${scope.organizationId}/groups/${scope.groupId}/schedule/versions/${created}`}
            >
              Open the new draft
            </a>
          </p>
          <p className="mt-sp-2 text-sm text-text-muted">
            Period {periodId} · the published version it came from is unchanged.
          </p>
        </div>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Revert — publishing forward, with its own friction
 * ──────────────────────────────────────────────────────────────────────────── */

function RevertPanel({
  version,
  history,
  periodId,
  onClose,
}: {
  version: PublishedVersionView;
  history: VersionHistory;
  periodId: string;
  onClose: () => void;
}): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const idempotency = useRetainedIdempotencyKey(`revert:${version.id}`);

  const [typedPhrase, setTypedPhrase] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [moved, setMoved] = useState<CurrentVersionMovedError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResultWire | null>(null);

  const fieldIds = useFieldIds('revert', ['confirmationPhrase', 'acknowledged']);
  const required = publicationConfirmationPhrase({
    periodName: history.period.name,
    isRevert: true,
  });

  const revert = useMutation({
    mutationFn: () =>
      revertPeriod(scope, periodId, {
        revertToVersionId: version.id,
        idempotencyKey: idempotency.key,
        expectedPriorCurrentVersionId: history.currentVersionId,
        acknowledged: true,
        confirmationPhrase: typedPhrase,
      }),
    onSuccess: (published) => {
      setResult(published);
      void queryClient.invalidateQueries({ queryKey: ['publication-history'] });
    },
    onError: (error: unknown) => {
      if (error instanceof CurrentVersionMovedError) {
        setMoved(error);
        return;
      }
      if (error instanceof ValidationError) {
        setProblems(error.problems);
        return;
      }
      setFailure(
        error instanceof ApiError
          ? isPermissionDenied(error)
            ? 'You do not have permission to revert in this group.'
            : error.message
          : 'The revert could not be completed.',
      );
    },
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setProblems([]);
    setFailure(null);
    const found: FieldProblem[] = [];
    if (!acknowledged) {
      found.push({ field: 'acknowledged', message: 'Confirm that you understand what a revert does.' });
    }
    if (!publicationPhraseMatches(typedPhrase, required)) {
      found.push({
        field: 'confirmationPhrase',
        message: `Type “${required}” exactly to confirm.`,
      });
    }
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    revert.mutate();
  };

  return (
    <section
      aria-labelledby="revert-heading"
      className="flex flex-col gap-sp-3 rounded-panel border border-border bg-surface-raised p-sp-4"
      data-testid="revert-panel"
    >
      <h2 className="text-lg font-semibold text-text" id="revert-heading">
        Revert to {versionLabel(version)}
      </h2>
      <p className="text-text">
        This does <strong>not</strong> delete anything. It copies {versionLabel(version)}&apos;s
        content into a new version and publishes that, so the version people are working to now
        becomes superseded and stays in the history. Everyone affected by the change will see their
        schedule change again.
      </p>

      {result !== null ? (
        <div data-testid="revert-result" role="status">
          <p className="font-semibold text-text">
            {result.replay
              ? 'Already reverted — nothing was published a second time.'
              : `Reverted. The period is now on version ${String(result.versionNumber)}.`}
          </p>
          <p className="text-text-muted">
            {result.affectedMembershipCount === 1
              ? '1 person was affected.'
              : `${String(result.affectedMembershipCount)} people were affected.`}
          </p>
          <p className="mt-sp-3">
            <button className={SECONDARY_BUTTON_CLASS} data-testid="revert-close" onClick={onClose} type="button">
              Close
            </button>
          </p>
        </div>
      ) : (
        <form className="flex flex-col gap-sp-3" data-testid="revert-form" noValidate onSubmit={onSubmit}>
          <ValidationSummary fieldIds={fieldIds} formName="revert" problems={problems} />

          {moved === null ? null : (
            <div className="rounded-panel border border-danger p-sp-3" data-testid="revert-current-version-moved" role="alert">
              <p className="font-semibold text-danger">Another publication reached this period first.</p>
              <p className="text-text">
                Nothing was reverted. Reload the history and decide again against what is actually
                live.
              </p>
              <p className="mt-sp-2 text-sm text-text-muted">
                Reference <code className="font-mono">{moved.correlationId}</code>
              </p>
            </div>
          )}

          {failure === null ? null : (
            <p className="rounded-panel border border-danger p-sp-3 text-text" data-testid="revert-failed" role="alert">
              {failure}
            </p>
          )}

          <div className="flex items-start gap-sp-2">
            <input
              checked={acknowledged}
              className="mt-sp-1 min-h-target min-w-target"
              data-testid="revert-acknowledge"
              id={fieldIds.acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              type="checkbox"
            />
            <label className="text-text" htmlFor={fieldIds.acknowledged}>
              I understand this publishes a new version and changes the live schedule.
            </label>
          </div>

          <Field
            help={`Type this exactly: ${required}`}
            id={fieldIds.confirmationPhrase}
            label="Confirm the revert"
            problem={problems.find((problem) => problem.field === 'confirmationPhrase')?.message}
          >
            {(attributes) => (
              <input
                {...attributes}
                autoComplete="off"
                className={CONTROL_CLASS}
                data-testid="revert-phrase"
                onChange={(event) => setTypedPhrase(event.target.value)}
                type="text"
                value={typedPhrase}
              />
            )}
          </Field>

          <div className="flex flex-wrap gap-sp-2">
            <button
              className={PRIMARY_BUTTON_CLASS}
              data-testid="revert-confirm"
              disabled={revert.isPending}
              type="submit"
            >
              {revert.isPending ? 'Reverting…' : 'Revert now'}
            </button>
            <button
              className={SECONDARY_BUTTON_CLASS}
              data-testid="revert-cancel"
              disabled={revert.isPending}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
