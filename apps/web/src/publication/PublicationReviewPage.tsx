import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState, type FormEvent, type JSX } from 'react';
import {
  publicationPhraseMatches,
  type PublicationReview,
  type PublishResultWire,
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
import {
  CurrentVersionMovedError,
  StaleReviewError,
  fetchPublicationReview,
  publishVersion,
  signOffVersion,
} from './api.js';
import { DifferenceView } from './DifferenceView.js';
import { PublicationLayout, publicationSections } from './PublicationLayout.js';
import { useRetainedIdempotencyKey } from './idempotency.js';

/**
 * Publication review and confirmation (OPUS-M3-005; SPEC-05 §6, SP-E §3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What this screen is for
 *
 * It is the last thing a scheduler sees before an irreversible act. So it shows,
 * in this order: **what will change**, **who it changes it for**, **what would
 * stop it**, and only then the control that does it.
 *
 * ## I-13, on an act that is not a create
 *
 * `Publish this version…` opens the confirmation panel and issues **zero**
 * requests — budgeted at 0 in `budgets.json`, where the number can never be
 * raised without the invariant changing first. Filling the panel issues zero
 * as well. Nothing reaches the server until the explicit confirm.
 *
 * ## Graduated friction (SP-E §3), and it is the SERVER's rule
 *
 * `publicationFrictionTier` is a shared contract function; the review response
 * carries the tier and the phrase the server computed, and the server recomputes
 * both inside the publishing transaction and refuses a confirmation that does
 * not satisfy them. This screen renders the tier it was given. A friction
 * control that only lives in the browser is decoration, and this repository has
 * shipped one twice.
 *
 * ## The idempotency key is minted ONCE and retained
 *
 * `useRetainedIdempotencyKey(versionId)` holds one key for as long as this
 * screen is publishing this version. Every attempt — a double-click, a retry
 * after a dropped connection, a click on "Try again" — carries the same key, so
 * the server replays instead of publishing twice. The key is renewed only when
 * the version changes. This is red-cased: regenerating it per attempt must make
 * the e2e fail.
 *
 * ## Both refusals are rendered explicitly, and neither is retried
 *
 * SP-E §1.4: stale context is a first-class state, surfaced as an interruption
 * and never as a silent retry.
 *
 *  - **`CURRENT_VERSION_MOVED`** — somebody else published first. The screen says
 *    so, names the version that won **by its NUMBER** (review N3: it printed the
 *    uuid, which names nothing to a reader), states that nothing was written —
 *    because nothing was — and offers one control: reload the review.
 *  - **`STALE_REVIEW`** — the draft changed while it was being read. Same shape,
 *    different sentence, same single control.
 *
 * ## The deny state is rendered, and the server is still the authority
 *
 * `schedule.publish` is grant-only (doc 08 §4). A scheduler without it sees the
 * whole review — reading a draft is `schedule.version.edit`, which they hold —
 * and sees the publish control **disabled with a written reason** rather than
 * absent, because a control that vanishes teaches nothing (SP-E §1.3). If such a
 * client submitted anyway, the route's own policy and the frozen service's
 * in-transaction re-evaluation both refuse it; `canPublish` renders honesty, it
 * does not grant anything.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function PublicationReviewPage(): JSX.Element {
  const scope = useGroupScope();
  const params = useParams({ strict: false }) as { versionId?: string };
  const versionId = params.versionId ?? '';

  const review = useQuery({
    queryKey: ['publication-review', scope.organizationId, scope.groupId, versionId],
    queryFn: () => fetchPublicationReview(scope, versionId),
    retry: false,
  });

  return (
    <PublicationLayout
      description="Everything this publication would change, everyone it would change it for, and anything that would stop it."
      sections={publicationSections(scope, review.data?.period.id ?? null, 'review')}
      title="Review before publishing"
    >
      <SurfaceState
        isLoading={review.isPending}
        error={review.error}
        isEmpty={false}
        emptyMessage="There is nothing to review."
        label="the publication review"
      >
        {review.data === undefined ? null : (
          <ReviewPanel review={review.data} versionId={versionId} />
        )}
      </SurfaceState>
    </PublicationLayout>
  );
}

function ReviewPanel({
  review,
  versionId,
}: {
  review: PublicationReview;
  versionId: string;
}): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const idempotency = useRetainedIdempotencyKey(versionId);

  const [isConfirming, setIsConfirming] = useState(false);
  const [typedPhrase, setTypedPhrase] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);
  const [moved, setMoved] = useState<CurrentVersionMovedError | null>(null);
  const [stale, setStale] = useState<StaleReviewError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResultWire | null>(null);

  const fieldIds = useFieldIds('publish', ['confirmationPhrase', 'acknowledged']);
  const blocked = review.blockers.length > 0;
  const needsPhrase = review.frictionTier === 'type-to-confirm';
  const phraseSatisfied =
    !needsPhrase || publicationPhraseMatches(typedPhrase, review.confirmationPhrase);

  const publish = useMutation({
    mutationFn: () =>
      publishVersion(scope, versionId, {
        idempotencyKey: idempotency.key,
        expectedPriorCurrentVersionId: review.expectedPriorCurrentVersionId,
        expectedReviewDigest: review.reviewDigest,
        acknowledged: true,
        ...(needsPhrase ? { confirmationPhrase: typedPhrase } : {}),
      }),
    onSuccess: (published) => {
      setResult(published);
      setIsConfirming(false);
      // PO-DEC-18: the SERVER is the authority on what the schedule now says, so
      // the review is re-read rather than patched from the response.
      void queryClient.invalidateQueries({ queryKey: ['publication-review'] });
    },
    onError: (error: unknown) => {
      if (error instanceof CurrentVersionMovedError) {
        setMoved(error);
        return;
      }
      if (error instanceof StaleReviewError) {
        setStale(error);
        return;
      }
      if (error instanceof ValidationError) {
        setProblems(error.problems);
        return;
      }
      setFailure(
        error instanceof ApiError
          ? isPermissionDenied(error)
            ? 'You do not have permission to publish in this group.'
            : error.message
          : 'The publication could not be completed.',
      );
    },
  });

  const reload = (): void => {
    setMoved(null);
    setStale(null);
    setFailure(null);
    setProblems([]);
    setIsConfirming(false);
    void queryClient.invalidateQueries({ queryKey: ['publication-review'] });
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setProblems([]);
    setFailure(null);
    const found: FieldProblem[] = [];
    if (!acknowledged) {
      found.push({
        field: 'acknowledged',
        message: 'Confirm that you have read the changes above.',
      });
    }
    if (needsPhrase && !phraseSatisfied) {
      found.push({
        field: 'confirmationPhrase',
        message: `Type “${review.confirmationPhrase}” exactly to confirm.`,
      });
    }
    if (found.length > 0) {
      // The client's pre-check issues NOTHING. A "helpful" call that let the
      // server produce the same message would be the amplification I-10 forbids.
      setProblems(found);
      return;
    }
    publish.mutate();
  };

  return (
    <div className="flex min-w-0 flex-col gap-sp-5">
      <section aria-labelledby="review-summary-heading" className="flex flex-col gap-sp-2">
        <h2 className="text-lg font-semibold text-text" id="review-summary-heading">
          {review.period.name}
        </h2>
        <p className="text-text-muted" data-testid="review-summary">
          {review.period.startDate} to {review.period.endDate} · times shown in {review.timezone} ·
          this version is {review.version.state}
        </p>
        <p className="text-text" data-testid="review-supersedes">
          {/* Three cases, and the third one used to be told the second one's
              sentence: after this version is published the review re-reads and
              `currentVersion` becomes THIS version, so the screen said it would
              supersede itself. */}
          {review.currentVersion === null
            ? 'Nothing is published for this period yet. This would be the first published version.'
            : review.currentVersion.id === review.version.id
              ? `This version IS what staff are working to now — it is version ${String(
                  review.currentVersion.versionNumber ?? 0,
                )}, published and permanent. Correct it by cloning it into a new draft and publishing forward.`
              : `Publishing this would supersede version ${String(
                  review.currentVersion.versionNumber ?? 0,
                )}, which is what staff are working to now.`}
        </p>
      </section>

      {/* ── what would stop it ───────────────────────────────────────────── */}
      <section aria-labelledby="review-blockers-heading" className="flex flex-col gap-sp-2">
        <h2 className="text-lg font-semibold text-text" id="review-blockers-heading">
          Before publishing
        </h2>
        <p className="text-sm text-text-muted" data-testid="review-validation-scope">
          This lists conflicts already recorded against this version and checks of the version&apos;s
          own state. Scheduling rules are not evaluated against a draft here.
        </p>

        {blocked ? (
          <ul className="flex flex-col gap-sp-2" data-testid="review-blockers">
            {review.blockers.map((blocker, index) => (
              <li
                className="rounded-panel border border-danger bg-surface-raised p-sp-3"
                data-testid={`blocker-${blocker.code}`}
                key={`${blocker.code}:${blocker.conflictId ?? String(index)}`}
              >
                <span className="font-semibold text-danger">Blocked</span>
                <span className="text-text"> — {blocker.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-text" data-testid="review-no-blockers">
            Nothing blocks this publication.
          </p>
        )}

        {review.warnings.length === 0 ? (
          <p className="text-text-muted" data-testid="review-no-warnings">
            No warnings.
          </p>
        ) : (
          <ul className="flex flex-col gap-sp-2" data-testid="review-warnings">
            {review.warnings.map((warning) => (
              <li
                className="rounded-panel border border-border bg-surface-raised p-sp-3"
                data-testid={`warning-${warning.code}`}
                key={warning.code}
              >
                <span className="font-semibold text-text">Worth checking</span>
                <span className="text-text-muted"> — {warning.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── the difference ───────────────────────────────────────────────── */}
      <section aria-labelledby="review-difference-heading" className="flex min-w-0 flex-col gap-sp-3">
        <h2 className="text-lg font-semibold text-text" id="review-difference-heading">
          The differences
        </h2>
        <DifferenceView difference={review.difference} testId="review-diff" timezone={review.timezone} />
      </section>

      {/* ── sign-off, when the version has not reached `approved` yet ────── */}
      {review.version.state === 'draft' || review.version.state === 'in_review' ? (
        <SignOffPanel state={review.version.state} versionId={versionId} />
      ) : null}

      {/* ── the act ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="review-publish-heading" className="flex flex-col gap-sp-3">
        <h2 className="text-lg font-semibold text-text" id="review-publish-heading">
          Publish
        </h2>

        {result === null ? null : (
          <div
            className="rounded-panel border border-border bg-surface-raised p-sp-3"
            data-testid="publish-result"
            role="status"
          >
            <p className="font-semibold text-text">
              {result.replay
                ? 'Already published — nothing was published a second time.'
                : `Published as version ${String(result.versionNumber)}.`}
            </p>
            <p className="text-text-muted">
              {result.affectedMembershipCount === 1
                ? '1 person was affected.'
                : `${String(result.affectedMembershipCount)} people were affected.`}{' '}
              {result.replay
                ? 'This confirmation matched a publication that had already happened, so it was answered from the record rather than repeated.'
                : 'This version can no longer be edited. Correct it by cloning it into a new draft and publishing forward.'}
            </p>
          </div>
        )}

        {moved === null ? null : (
          <div
            className="rounded-panel border border-danger bg-surface-raised p-sp-3"
            data-testid="publish-current-version-moved"
            role="alert"
          >
            <p className="font-semibold text-danger">
              Another publication reached this period first.
            </p>
            {/* The version NUMBER, not its uuid. Review finding N3: this
                docblock promised the panel "names the version" and it printed a
                raw uuid, which names nothing to the person being told their
                publication was refused. The number is what a scheduler calls a
                version everywhere else on this surface. */}
            <p className="text-text">
              Nothing was published.{' '}
              {moved.currentVersionNumber === null
                ? 'The version that is current now is not the one you reviewed.'
                : `Version ${String(moved.currentVersionNumber)} is current now, not the version you reviewed.`}{' '}
              Reload the review and decide again against what is actually live.
            </p>
            <p className="mt-sp-2 text-sm text-text-muted">
              Reference <code className="font-mono">{moved.correlationId}</code>
            </p>
            <p className="mt-sp-3">
              <button
                className={PRIMARY_BUTTON_CLASS}
                data-testid="publish-reload-review"
                onClick={reload}
                type="button"
              >
                Reload the review
              </button>
            </p>
          </div>
        )}

        {stale === null ? null : (
          <div
            className="rounded-panel border border-danger bg-surface-raised p-sp-3"
            data-testid="publish-stale-review"
            role="alert"
          >
            <p className="font-semibold text-danger">This draft changed while you were reading it.</p>
            <p className="text-text">
              Nothing was published. Reload the review so what you confirm is what would go out.
            </p>
            <p className="mt-sp-2 text-sm text-text-muted">
              Reference <code className="font-mono">{stale.correlationId}</code>
            </p>
            <p className="mt-sp-3">
              <button
                className={PRIMARY_BUTTON_CLASS}
                data-testid="publish-reload-review-stale"
                onClick={reload}
                type="button"
              >
                Reload the review
              </button>
            </p>
          </div>
        )}

        {failure === null ? null : (
          <div
            className="rounded-panel border border-danger bg-surface-raised p-sp-3"
            data-testid="publish-failed"
            role="alert"
          >
            <p className="font-semibold text-danger">The publication did not complete.</p>
            <p className="text-text">{failure}</p>
            <p className="mt-sp-2 text-sm text-text-muted">
              If you try again, this will be treated as the same publication rather than a second
              one, so it cannot publish twice.
            </p>
          </div>
        )}

        {!review.canPublish ? (
          <p
            className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
            data-testid="publish-denied"
          >
            You can read this review, but publishing needs the publish permission, which you do not
            have in this group. Ask a group administrator if you need it.
          </p>
        ) : blocked ? (
          <p
            className="rounded-panel border border-border bg-surface-raised p-sp-3 text-text"
            data-testid="publish-blocked"
          >
            Publishing is blocked until everything listed above is cleared.
          </p>
        ) : !isConfirming ? (
          <p>
            <button
              className={PRIMARY_BUTTON_CLASS}
              data-testid="publish-open-confirm"
              onClick={() => {
                // I-13: local state only. Nothing is published, nothing is fetched.
                setProblems([]);
                setFailure(null);
                setIsConfirming(true);
              }}
              type="button"
            >
              Publish this version…
            </button>
          </p>
        ) : (
          <form
            className="flex flex-col gap-sp-3 rounded-panel border border-border bg-surface-raised p-sp-4"
            data-testid="publish-confirm-form"
            noValidate
            onSubmit={onSubmit}
          >
            <ValidationSummary fieldIds={fieldIds} formName="publish" problems={problems} />

            <p className="text-text" data-testid="publish-friction-tier">
              {needsPhrase
                ? 'This changes a schedule people are already working to, so it needs a typed confirmation.'
                : 'Nothing is published for this period yet and nobody is affected, so a single confirmation is enough.'}
            </p>

            <div className="flex items-start gap-sp-2">
              <input
                checked={acknowledged}
                className="mt-sp-1 min-h-target min-w-target"
                data-testid="publish-acknowledge"
                id={fieldIds.acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                type="checkbox"
              />
              <label className="text-text" htmlFor={fieldIds.acknowledged}>
                I have read the changes above and I am publishing them.
              </label>
            </div>

            {needsPhrase ? (
              <Field
                help={`Type the period name exactly: ${review.confirmationPhrase}`}
                id={fieldIds.confirmationPhrase}
                label="Confirm by typing the period name"
                problem={problems.find((problem) => problem.field === 'confirmationPhrase')?.message}
              >
                {(attributes) => (
                  <input
                    {...attributes}
                    autoComplete="off"
                    className={CONTROL_CLASS}
                    data-testid="publish-phrase"
                    onChange={(event) => setTypedPhrase(event.target.value)}
                    type="text"
                    value={typedPhrase}
                  />
                )}
              </Field>
            ) : null}

            <div className="flex flex-wrap gap-sp-2">
              <button
                className={PRIMARY_BUTTON_CLASS}
                data-testid="publish-confirm"
                // Disabled while a request is in flight: a second click must not
                // become a second request. The retained key makes a genuine
                // RETRY safe; this makes an impatient double-click free.
                disabled={publish.isPending}
                type="submit"
              >
                {publish.isPending ? 'Publishing…' : 'Publish now'}
              </button>
              <button
                className={SECONDARY_BUTTON_CLASS}
                data-testid="publish-cancel"
                disabled={publish.isPending}
                onClick={() => {
                  setIsConfirming(false);
                  setProblems([]);
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sign-off — a DISCLOSED ADDITION to packet 32 §10d
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Move a draft to `in_review` and then to `approved`.
 *
 * Sign-off is the step between "I have finished authoring this" and "publish
 * it", and the frozen service treats it as part of the publication flow —
 * `transitionVersion` re-checks the same hard-breach prerequisite the
 * publication transaction re-checks at commit. Before this control existed no
 * version could reach `approved` through any HTTP surface, so this whole screen
 * was unreachable. It is disclosed in the return report and removable in one
 * hunk.
 *
 * It carries `schedule.version.edit`, not `schedule.publish`: approving a draft
 * is not publishing it, and a scheduler without the publish grant can and should
 * still be able to sign a draft off for somebody who has it.
 */
function SignOffPanel({
  versionId,
  state,
}: {
  versionId: string;
  state: 'draft' | 'in_review';
}): JSX.Element {
  const scope = useGroupScope();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const next = state === 'draft' ? 'in_review' : 'approved';

  const signOff = useMutation({
    mutationFn: () => signOffVersion(scope, versionId, { to: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['publication-review'] });
    },
    onError: (error: unknown) => {
      setFailure(
        error instanceof ApiError
          ? isPermissionDenied(error)
            ? 'You do not have permission to sign this version off.'
            : error.message
          : 'The version could not be moved.',
      );
    },
  });

  return (
    <section
      aria-labelledby="signoff-heading"
      className="flex flex-col gap-sp-3 rounded-panel border border-border bg-surface-raised p-sp-4"
      data-testid="signoff-panel"
    >
      <h2 className="text-lg font-semibold text-text" id="signoff-heading">
        Sign-off
      </h2>
      <p className="text-text">
        {state === 'draft'
          ? 'This version is still a draft. Send it for review before it can be approved and published.'
          : 'This version is in review. Approving it makes it publishable; approval is refused while a hard-breach conflict is open.'}
      </p>

      {failure === null ? null : (
        <p className="rounded-panel border border-danger p-sp-3 text-text" data-testid="signoff-failed" role="alert">
          {failure}
        </p>
      )}

      <p>
        <button
          className={SECONDARY_BUTTON_CLASS}
          data-testid="signoff-advance"
          disabled={signOff.isPending}
          onClick={() => {
            setFailure(null);
            signOff.mutate();
          }}
          type="button"
        >
          {state === 'draft' ? 'Send for review' : 'Approve for publication'}
        </button>
      </p>
    </section>
  );
}
