import * as Separator from '@radix-ui/react-separator';
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';

import { ApiError, fetchHealth } from '../api/client.js';

/**
 * The application shell.
 *
 * Deliberately **not** a product screen. It renders the frame every product
 * screen will sit inside — skip link, landmark structure, heading order, one
 * Radix primitive, one live region — so that the accessibility gate has real
 * structure to assert against from the first commit rather than an empty div.
 *
 * The connection panel exercises the typed contract path end to end
 * (zod schema -> API -> client parse -> render) and gives the
 * requests-per-interaction harness a genuine single-action interaction to
 * measure (I-10: one user action, one request).
 */
export function ShellPage(): JSX.Element {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    // No retry: a retry storm is exactly the request amplification I-10 forbids,
    // and it would make the request-budget measurement meaningless.
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
    gcTime: 0,
  });

  return (
    <>
      <a
        href="#main"
        className="sr-only rounded-control bg-accent px-4 py-2 text-accent-contrast focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
      >
        Skip to main content
      </a>

      <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
        <header>
          <p className="text-sm font-medium uppercase tracking-wide text-text-muted">
            SchedulePoint
          </p>
          <h1 className="text-2xl font-semibold text-text">Application shell</h1>
          <p className="mt-2 text-text-muted">
            Scaffold only. No product functionality is implemented in this build.
          </p>
        </header>

        <Separator.Root
          className="h-px w-full bg-border"
          decorative
          orientation="horizontal"
          data-testid="shell-separator"
        />

        <main id="main" className="flex flex-col gap-4">
          <section aria-labelledby="connection-heading" className="flex flex-col gap-3">
            <h2 id="connection-heading" className="text-lg font-semibold text-text">
              API connection
            </h2>

            <div
              className="rounded-panel border border-border bg-surface-raised p-4"
              role="status"
              aria-live="polite"
              data-testid="connection-status"
            >
              {health.isPending ? <p className="text-text-muted">Checking the API…</p> : null}

              {health.isSuccess ? (
                <p className="text-text">
                  API reachable. Server time{' '}
                  <time dateTime={health.data.checkedAt}>{health.data.checkedAt}</time>, correlation
                  id <code className="font-mono">{health.data.correlationId}</code>.
                </p>
              ) : null}

              {health.isError ? (
                <p className="text-danger">
                  API unreachable
                  {health.error instanceof ApiError && health.error.correlationId !== undefined
                    ? ` (correlation id ${health.error.correlationId})`
                    : ''}
                  . This is expected when the shell is served without the API.
                </p>
              ) : null}
            </div>

            <div>
              <button
                type="button"
                className="min-h-target rounded-control bg-accent px-4 py-2 font-medium text-accent-contrast"
                onClick={() => {
                  void health.refetch();
                }}
                data-testid="retry-health"
              >
                Check again
              </button>
            </div>
          </section>
        </main>

        <footer className="mt-auto text-sm text-text-muted">
          <p>Synthetic environment. No real staff, patient, or customer data exists here.</p>
        </footer>
      </div>
    </>
  );
}
