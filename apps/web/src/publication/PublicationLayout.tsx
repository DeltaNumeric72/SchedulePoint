import type { JSX, ReactNode } from 'react';

import { useGroupScope } from '../catalogue/CatalogueLayout.js';

/**
 * The frame every publication surface sits in (OPUS-M3-005).
 *
 * ## The declared context is in the URL, exactly as the catalogue's and the
 * ## authoring surface's are
 *
 * SPEC-01 §2.2/§3: tenant context is client-declared and server-verified, and
 * switching it is explicit and visible. `useGroupScope` is imported from the
 * catalogue layout rather than reimplemented — a second reader of the same URL
 * params is a second place for the two to disagree about what "the current
 * group" means, which is the CAR-001 defect class.
 *
 * ## Why this is not `ScheduleLayout`
 *
 * The authoring frame says "Manual authoring is for override, recovery and
 * fixed assignments" and navigates to periods and drafts. Publication is a
 * different act performed under a different, grant-only capability, and the
 * sentence this frame has to carry is a different one: **what is published
 * cannot be edited.** Reusing the authoring chrome would make `aria-current`
 * lie about where the user is and would put an irreversible act inside a
 * section labelled for drafting.
 *
 * ## The immutability statement is on the screen, not only in a docblock
 *
 * I-18 and non-bypass rule 5 are the rules a reader of this surface most needs
 * to understand, because every question they will ask ("can I fix that?", "can I
 * delete that version?") has the same answer and it is not obvious. So the frame
 * says it once, plainly, on every page.
 */

export interface PublicationSection {
  readonly href: string;
  readonly label: string;
  readonly isCurrent: boolean;
}

export function PublicationLayout({
  title,
  description,
  sections,
  children,
}: {
  title: string;
  description: string;
  sections: readonly PublicationSection[];
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
            SchedulePoint · Publication
          </p>
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <p className="mt-sp-2 text-text-muted">{description}</p>
          {/* I-18 / non-bypass rule 5, on the screen and not only in a comment. */}
          <p className="mt-sp-2 text-sm text-text-muted" data-testid="publication-immutability-note">
            A published version can never be edited or deleted. Correct it by cloning it into a new
            draft and publishing forward; the earlier version stays in the history, marked as
            superseded.
          </p>
        </header>

        <nav aria-label="Publication sections">
          <ul className="flex flex-wrap gap-sp-2">
            {sections.map((section) => (
              <li key={section.href}>
                <a
                  {...(section.isCurrent ? { 'aria-current': 'page' as const } : {})}
                  className={
                    section.isCurrent
                      ? 'inline-flex min-h-target items-center rounded-control border border-accent px-sp-3 py-sp-2 text-accent'
                      : 'inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text'
                  }
                  href={section.href}
                >
                  {section.label}
                </a>
              </li>
            ))}
            <li>
              <a
                className="inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text"
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

/** The section list every publication page renders, with one marked current. */
export function publicationSections(
  scope: { organizationId: string; groupId: string },
  periodId: string | null,
  current: 'published' | 'history' | 'review' | 'comparison' | null,
): PublicationSection[] {
  if (periodId === null) return [];
  const base = `/organizations/${scope.organizationId}/groups/${scope.groupId}/publication/periods/${periodId}`;
  return [
    { href: `${base}/published`, label: 'Published schedule', isCurrent: current === 'published' },
    { href: `${base}/history`, label: 'Version history', isCurrent: current === 'history' },
  ];
}
