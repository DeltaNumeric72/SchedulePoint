import { Link } from '@tanstack/react-router';
import type { JSX, ReactNode } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';

/**
 * The frame the two staff-facing schedule surfaces sit in (OPUS-M3-006).
 *
 * ## The declared context is in the URL, as everywhere else
 *
 * SPEC-01 §2.2/§3: tenant context is client-declared and server-verified, and
 * switching it is explicit and visible. `useGroupScope` is imported from the
 * catalogue layout rather than reimplemented — a second reader of the same URL
 * params is a second place for the two to disagree about what "the current
 * group" means (the CAR-001 defect class).
 *
 * ## The membership is in the URL too, and the server does not trust it
 *
 * There is no client-side session-context read yet — the context probe is a
 * POST harness route, not a `/me` — so the shell has nowhere to learn the
 * viewer's membership from. Carrying it in the path is the honest interim: it
 * survives a bookmark and a second tab, it is what the server's object policy
 * binds to, and **the server answers from the verified context regardless**, so
 * a hand-edited URL naming somebody else is a `404` rather than a disclosure.
 * Recorded as a known limitation; when a session read lands, the shell supplies
 * it and the path parameter can become a default rather than a requirement.
 *
 * ## Why this is not `ScheduleLayout`
 *
 * That frame says "Schedule" and announces that manual authoring is override and
 * recovery — a statement addressed to a scheduler about a tool they operate.
 * This surface is addressed to the person being scheduled, its navigation names
 * different things, and its `aria-current` would lie if it borrowed the
 * authoring chrome.
 */

export function MyScheduleLayout({
  title,
  description,
  membershipId,
  children,
}: {
  title: string;
  description: string;
  /** `null` on the daily sheet, which is not about one person. */
  membershipId: string | null;
  children: ReactNode;
}): JSX.Element {
  const scope = useGroupScope();

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
            SchedulePoint · Published schedule
          </p>
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <p className="mt-sp-2 text-text-muted">{description}</p>
          {/* Doc 07 §1, on the screen rather than only in a docblock: what staff
              read is the published version. A draft is not a schedule yet. */}
          <p className="mt-sp-2 text-sm text-text-muted" data-testid="published-only-note">
            This is the published schedule. Drafts a scheduler is still working on are not shown
            here.
          </p>
        </header>

        <nav aria-label="Schedule views">
          <ul className="flex flex-wrap gap-sp-2">
            {membershipId === null ? null : (
              <li>
                <Link
                  to="/organizations/$organizationId/groups/$groupId/my-schedule/$membershipId"
                  params={{
                    organizationId: scope.organizationId,
                    groupId: scope.groupId,
                    membershipId,
                  }}
                  activeProps={{ 'aria-current': 'page' }}
                  className="inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text aria-[current=page]:border-accent aria-[current=page]:text-accent"
                >
                  My schedule
                </Link>
              </li>
            )}
          </ul>
        </nav>

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
