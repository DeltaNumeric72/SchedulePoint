import { Link } from '@tanstack/react-router';
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
 * ## The section navigation uses ROUTER links, not plain anchors (M3-005 N4)
 *
 * They were `<a href>`, which is a full document navigation: the SPA is torn
 * down and rebuilt, every cached query is discarded, and the shell's health
 * read runs again. That is an amplification an accessible-looking anchor hides
 * (I-10), and it made moving between two publication sections cost more
 * requests than opening the surface did. `<Link>` also gives `aria-current` from
 * the router's own idea of the active route rather than from a boolean each page
 * computes, so the two cannot disagree about where the user is.
 *
 * The "Skip to main content" anchor stays an `<a href="#main">`: it is a
 * same-document fragment link and turning it into a router link would break it.
 *
 * ## The immutability statement is on the screen, not only in a docblock
 *
 * I-18 and non-bypass rule 5 are the rules a reader of this surface most needs
 * to understand, because every question they will ask ("can I fix that?", "can I
 * delete that version?") has the same answer and it is not obvious. So the frame
 * says it once, plainly, on every page.
 */

export interface PublicationSection {
  /** The router path template, e.g. `/organizations/$organizationId/…/published`. */
  readonly to: string;
  readonly params: Record<string, string>;
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
            <li>
              <Link
                className="inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text"
                params={{ organizationId: scope.organizationId, groupId: scope.groupId }}
                to="/organizations/$organizationId/groups/$groupId/schedule/periods"
              >
                Periods and drafts
              </Link>
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
  const base = '/organizations/$organizationId/groups/$groupId/publication/periods/$periodId';
  const params = {
    organizationId: scope.organizationId,
    groupId: scope.groupId,
    periodId,
  };
  return [
    { to: `${base}/published`, params, label: 'Published schedule', isCurrent: current === 'published' },
    { to: `${base}/history`, params, label: 'Version history', isCurrent: current === 'history' },
  ];
}
