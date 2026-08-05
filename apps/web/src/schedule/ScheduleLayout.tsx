import type { JSX, ReactNode } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';

/**
 * The frame every schedule-authoring surface sits in (OPUS-M3-004).
 *
 * ## The declared context is in the URL, exactly as the catalogue's is
 *
 * SPEC-01 §2.2/§3: tenant context is client-declared and server-verified, and
 * switching it is explicit and visible. `useGroupScope` is imported from the
 * catalogue layout rather than reimplemented — a second reader of the same URL
 * params is a second place for the two to disagree about what "the current
 * group" means, which is the CAR-001 defect class.
 *
 * ## Why this is not `CatalogueLayout`
 *
 * The catalogue's navigation names catalogue sections and its header says
 * "Catalogue". Authoring a schedule is a different task performed by the same
 * person, and doc 08 §6 keeps "Author catalogue & rules" and "author the
 * schedule" on separate rows. Reusing the catalogue's chrome would put the
 * schedule inside a section it does not belong to and would make the
 * `aria-current` navigation lie about where the user is.
 *
 * ## Manual authoring is override and recovery, and the page says so
 *
 * Non-bypass rule 7 (I-05): manual scheduling is never the production
 * mechanism. That is stated on the surface itself rather than only in a
 * docblock, so a scheduler reading the screen knows what this is for.
 */

export function ScheduleLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
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

      <div className="mx-auto flex min-h-screen w-full min-w-0 max-w-6xl flex-col gap-sp-5 p-sp-4">
        <header>
          <p className="text-sm font-medium uppercase tracking-wide text-text-muted">
            SchedulePoint · Schedule
          </p>
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <p className="mt-sp-2 text-text-muted">{description}</p>
          {/* I-05 / non-bypass rule 7, on the screen and not only in a comment. */}
          <p className="mt-sp-2 text-sm text-text-muted" data-testid="schedule-manual-note">
            Manual authoring is for override, recovery and fixed assignments. Automated scheduling
            is the production mechanism and arrives in a later release.
          </p>
        </header>

        <nav aria-label="Schedule sections">
          <ul className="flex flex-wrap gap-sp-2">
            <li>
              <a
                aria-current="page"
                className="inline-flex min-h-target items-center rounded-control border border-accent px-sp-3 py-sp-2 text-accent"
                href={`/organizations/${scope.organizationId}/groups/${scope.groupId}/schedule/periods`}
              >
                Periods and drafts
              </a>
            </li>
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
