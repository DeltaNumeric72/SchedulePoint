import { useState, type JSX, type ReactNode } from 'react';

import { ApiError } from '../api/client.js';
import { ValidationSummary, type FieldProblem } from '../components/Form.js';

/**
 * The frame every authentication page renders inside.
 *
 * ## Why the pages share a frame rather than a component library
 *
 * Landmark structure is the thing axe checks and the thing a screen-reader user
 * navigates by, and it is the thing five near-identical pages get subtly
 * different when each writes its own. One `<main>`, one `<h1>` per page, one
 * skip link, one status region — declared here, so a new authentication page
 * inherits them rather than remembering them.
 *
 * ## The status region is `role="status"`, and the error region is `role="alert"`
 *
 * The distinction is not decorative. `status` is polite: "we have sent a link if
 * that address exists" waits for a pause. `alert` is assertive: a refused
 * credential interrupts, because the user is standing at a form that did not do
 * what they asked. SPEC-14 AC-11 and the SP-E brief §3 both draw this line.
 *
 * ## I-13 — nothing persists before an explicit submit
 *
 * There is no control on any of these pages that writes anything on click. Every
 * page is a form with one submit button, and no page performs a request on
 * mount. `apps/web/e2e/authn.spec.ts` asserts the second half directly by
 * counting requests after a bare page load.
 */

export interface AuthnPageProps {
  readonly title: string;
  /** One sentence under the heading. Never instructions the server will contradict. */
  readonly intro: string;
  readonly children: ReactNode;
}

export function AuthnPage({ title, intro, children }: AuthnPageProps): JSX.Element {
  return (
    <div className="min-h-screen bg-surface-raised text-text">
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:left-sp-4 focus:top-sp-4 focus:rounded-control focus:bg-surface focus:px-sp-3 focus:py-sp-2"
        href="#authn-main"
      >
        Skip to main content
      </a>
      <header className="border-b border-border bg-surface px-sp-4 py-sp-3">
        <p className="font-semibold">SchedulePoint</p>
      </header>
      <main className="mx-auto max-w-xl px-sp-4 py-sp-6" id="authn-main">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-sp-2 text-text-muted">{intro}</p>
        <div className="mt-sp-5 rounded-panel border border-border bg-surface p-sp-5">
          {children}
        </div>
      </main>
      <footer className="px-sp-4 py-sp-5 text-sm text-text-muted">
        <p>Synthetic development environment. No real accounts exist here.</p>
      </footer>
    </div>
  );
}

/**
 * The submit-state machine every authentication form uses.
 *
 * Four states, and each of them is a rendered state rather than a spinner:
 * `idle`, `submitting`, `failed` (with the server's own message) and `done`
 * (with a status announcement). A form with only "idle" and "spinner" cannot
 * tell a keyboard user what happened.
 */
export type SubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'failed'; readonly message: string; readonly correlationId?: string }
  | { readonly kind: 'done'; readonly message: string };

export interface AuthnFormController {
  readonly state: SubmitState;
  readonly problems: readonly FieldProblem[];
  /**
   * Runs one action, and exactly one.
   *
   * The button is disabled while `submitting`, so a double-click cannot become
   * two requests (I-10). `validate` runs first and, on failure, no request is
   * made at all — which is what keeps the pre-check from becoming a second
   * round trip.
   */
  submit(
    validate: () => readonly FieldProblem[],
    action: () => Promise<string>,
  ): Promise<void>;
  reset(): void;
}

export function useAuthnForm(): AuthnFormController {
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const [problems, setProblems] = useState<readonly FieldProblem[]>([]);

  return {
    state,
    problems,
    submit: async (validate, action) => {
      const found = validate();
      setProblems(found);
      if (found.length > 0) {
        // No request. A client-side pre-check that still called the server would
        // be the amplification I-10 forbids, dressed up as helpfulness.
        setState({ kind: 'idle' });
        return;
      }
      setState({ kind: 'submitting' });
      try {
        const message = await action();
        setState({ kind: 'done', message });
      } catch (error) {
        setState({
          kind: 'failed',
          // The typed envelope's message, verbatim. The fixed 5xx text is shown
          // as it is and never expanded (SP-E brief §3).
          message:
            error instanceof ApiError
              ? error.message
              : 'The request could not be completed.',
          ...(error instanceof ApiError && error.correlationId !== undefined
            ? { correlationId: error.correlationId }
            : {}),
        });
      }
    },
    reset: () => {
      setState({ kind: 'idle' });
      setProblems([]);
    },
  };
}

export interface AuthnStatusProps {
  readonly state: SubmitState;
  readonly problems: readonly FieldProblem[];
  readonly fieldIds: Readonly<Record<string, string>>;
  readonly formName: string;
}

/** The announcement region and the validation summary, in the order they are read. */
export function AuthnStatus({
  state,
  problems,
  fieldIds,
  formName,
}: AuthnStatusProps): JSX.Element {
  return (
    <>
      <ValidationSummary problems={problems} fieldIds={fieldIds} formName={formName} />
      {state.kind === 'failed' ? (
        <div
          className="mb-sp-4 rounded-panel border border-danger bg-surface-raised p-sp-4"
          role="alert"
          data-testid="authn-error"
        >
          <p className="font-semibold text-danger">{state.message}</p>
          {state.correlationId === undefined ? null : (
            <p className="mt-sp-2 text-sm text-text-muted">
              Reference <code className="font-mono">{state.correlationId}</code>
            </p>
          )}
        </div>
      ) : null}
      <p
        className="mb-sp-4 text-text-muted"
        role="status"
        aria-live="polite"
        data-testid="authn-status"
      >
        {state.kind === 'submitting'
          ? 'Working…'
          : state.kind === 'done'
            ? state.message
            : ''}
      </p>
    </>
  );
}
