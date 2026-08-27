import { useParams } from '@tanstack/react-router';
import type { JSX, ReactNode } from 'react';

import type { GroupScope } from './api.js';

/**
 * The frame the vacation round sits in (OPUS-M5-003, doc 42 §5f Part B).
 *
 * ## The declared context is in the URL
 *
 * SPEC-01 §2.2 and §3: tenant context is client-declared and server-verified, and
 * switching it is explicit and visible rather than inferred. The organization and
 * group are path segments — the same segments the API route carries — so a
 * bookmark, a shared link and a second tab each declare what they mean instead of
 * inheriting a session-global "current group". That is the CAR-001 defect class
 * designed out of the URL space.
 *
 * The PERIOD is a path segment for the same reason it is a query in no version of
 * this surface: a vacation round is the thing being looked at, and a person
 * sending a colleague "the round I am looking at" should be sending the round.
 */

/** The declared context, read from the URL. Never from state, never inferred. */
export function useGroupScope(): GroupScope {
  const params = useParams({ strict: false }) as {
    organizationId?: string;
    groupId?: string;
  };
  return {
    organizationId: params.organizationId ?? '',
    groupId: params.groupId ?? '',
  };
}

export function VacationLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <>
      <a
        href="#main"
        className="sr-only rounded-control bg-accent px-sp-4 py-sp-2 text-accent-contrast focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:inline-flex focus:min-h-target focus:min-w-target focus:items-center"
      >
        Skip to main content
      </a>

      <div className="mx-auto flex min-h-screen w-full min-w-0 max-w-5xl flex-col gap-sp-5 p-sp-4">
        <header>
          <p className="text-sm font-medium uppercase tracking-wide text-text-muted">
            SchedulePoint · Vacation
          </p>
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <p className="mt-sp-2 text-text-muted">{description}</p>
        </header>

        <main className="flex min-w-0 flex-col gap-sp-4" id="main">
          {children}
        </main>

        <footer className="mt-auto text-sm text-text-muted">
          <p>Synthetic environment. No real staff, patient, or customer data exists here.</p>
        </footer>
      </div>
    </>
  );
}
