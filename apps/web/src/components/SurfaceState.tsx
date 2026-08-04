import type { JSX, ReactNode } from 'react';

import { ApiError } from '../api/client.js';

/**
 * The five states every surface has, as one component.
 *
 * SP-E brief and packet 30: "explicit loading/empty/error/validation/
 * permission-denied states for **every** surface". Writing them once means a new
 * surface gets all five by construction, and — more usefully — it means the
 * ANNOUNCEMENT semantics are decided once rather than per screen:
 *
 * | State | Semantics | Why |
 * |---|---|---|
 * | loading | `role="status"`, `aria-live="polite"` | a spinner nobody is told about is a blank screen to a screen-reader user |
 * | empty | ordinary prose, no live region | not an event; it is what the page says |
 * | error | `role="alert"` | it interrupts, because the user's action did not happen |
 * | permission denied | `role="alert"` | same, and worded so it never says WHY (SPEC-06 P-3) |
 *
 * ## The interface never lies about authority (SP-E §1.3)
 *
 * A `403` renders "you do not have permission to view this"; a `404` renders
 * "not found". They are DIFFERENT messages because the server already decided
 * which one to disclose, and re-interpreting either in the client would either
 * leak (calling a 404 a permission problem tells the user the thing exists) or
 * mislead (calling a 403 "not found" hides a fixable problem). The client
 * renders the server's verdict and adds nothing.
 */

export interface SurfaceStateProps {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly isEmpty: boolean;
  /** What to say when there is nothing yet. Never "no data". */
  readonly emptyMessage: string;
  /** The thing being loaded, named, for the loading announcement. */
  readonly label: string;
  readonly children: ReactNode;
}

/** True when the failure is the server saying "not permitted". */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'FORBIDDEN';
}

/** True when the failure is the server saying "not found" — which may mean either. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NOT_FOUND';
}

export function SurfaceState({
  isLoading,
  error,
  isEmpty,
  emptyMessage,
  label,
  children,
}: SurfaceStateProps): JSX.Element {
  if (isLoading) {
    return (
      <p
        className="rounded-panel border border-border bg-surface-raised p-sp-4 text-text-muted"
        role="status"
        aria-live="polite"
        data-testid="surface-loading"
      >
        Loading {label}…
      </p>
    );
  }

  if (error !== null && error !== undefined) {
    const denied = isPermissionDenied(error);
    const correlationId = error instanceof ApiError ? error.correlationId : undefined;
    return (
      <div
        className="rounded-panel border border-danger bg-surface-raised p-sp-4"
        role="alert"
        data-testid={denied ? 'surface-permission-denied' : 'surface-error'}
      >
        <p className="font-semibold text-danger">
          {denied ? `You do not have permission to view ${label}.` : `${label} could not be loaded.`}
        </p>
        <p className="mt-sp-2 text-text">
          {denied
            ? 'Ask a group administrator if you need access.'
            : /* The typed envelope's message, verbatim. The fixed 5xx text is
                 shown as it is and never expanded (SP-E §3). */
              (error instanceof ApiError ? error.message : 'The request could not be completed.')}
        </p>
        {correlationId === undefined ? null : (
          <p className="mt-sp-2 text-sm text-text-muted">
            Reference <code className="font-mono">{correlationId}</code>
          </p>
        )}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <p
        className="rounded-panel border border-border bg-surface-raised p-sp-4 text-text-muted"
        data-testid="surface-empty"
      >
        {emptyMessage}
      </p>
    );
  }

  return <>{children}</>;
}
