import { Link, useParams } from '@tanstack/react-router';
import type { JSX, ReactNode } from 'react';

import type { GroupScope } from './api.js';

/**
 * The frame every request surface sits in (OPUS-M5-005).
 *
 * ## The declared context is in the URL
 *
 * SPEC-01 §2.2/§3: tenant context is client-declared and server-verified, and
 * switching it is explicit and visible rather than inferred. The organization
 * and group are path segments — the same segments the API route carries — so a
 * bookmark, a shared link and a second tab each declare what they mean instead
 * of inheriting a session-global "current group". That is the CAR-001 defect
 * class designed out of the URL space.
 *
 * ## Why this is not the vacation frame, and not the schedule frame
 *
 * A request and a vacation week are "linked but distinct" (SPEC-08 §5), and the
 * glossary keeps the ten schedule concepts apart deliberately. This frame says
 * what a REQUEST is and links across to the round; the round's own frame says
 * what a round is. Merging them would put one `aria-current` on two different
 * acts and would make the vocabulary of one surface answer for the other.
 *
 * ## The section links are ROUTER links, not anchors
 *
 * `<a href>` is a full document navigation: the SPA is torn down and rebuilt and
 * every cached query is discarded, which is an amplification an accessible-
 * looking anchor hides (I-10). `<Link>` also derives `aria-current` from the
 * router's own idea of the active route rather than from a boolean each page
 * computes, so the two cannot disagree about where the user is.
 *
 * The "Skip to main content" control stays an `<a href="#main">`: it is a
 * same-document fragment link, and making it a router link would break it.
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

export interface RequestsSection {
  readonly to: string;
  readonly params: Record<string, string>;
  readonly label: string;
}

export function RequestsLayout({
  title,
  description,
  sections,
  children,
}: {
  title: string;
  description: string;
  sections?: readonly RequestsSection[];
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
            SchedulePoint · Requests
          </p>
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <p className="mt-sp-2 text-text-muted">{description}</p>
        </header>

        {sections === undefined || sections.length === 0 ? null : (
          <nav aria-label="Request sections">
            <ul className="flex flex-wrap gap-sp-2">
              {sections.map((section) => (
                <li key={section.to}>
                  <Link
                    activeProps={{ 'aria-current': 'page', className: 'border-accent text-accent' }}
                    className="inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text"
                    params={section.params}
                    to={section.to}
                  >
                    {section.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

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
