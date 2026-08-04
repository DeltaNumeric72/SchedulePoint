import { Link, useParams } from '@tanstack/react-router';
import type { JSX, ReactNode } from 'react';

import type { GroupScope } from './api.js';

/**
 * The frame the settings surfaces sit in (OPUS-M3-007).
 *
 * ## The declared context is in the URL, and that is deliberate
 *
 * SPEC-01 §2.2 and §3: tenant context is **client-declared and
 * server-verified**, and switching it is explicit and visible, never inferred.
 * The organization and group are path segments — the same segments the API route
 * carries — so a bookmark, a shared link and a second tab all declare what they
 * mean rather than inheriting a session-global "current group". That is the
 * CAR-001 defect class designed out of the URL space rather than guarded against
 * later.
 *
 * ## Why this is a separate section from the catalogue's "Group settings" page
 *
 * `apps/web/src/catalogue/GroupSettingsPage.tsx` (OPUS-M2-002) already carries
 * the pick-position count and the holiday calendar under
 * `/catalogue/group-settings`. It is not this packet's file — packet 32 §10a
 * gives this packet `apps/web/src/settings/**` and freezes the rest — so the
 * two live side by side at different URLs rather than being merged by a packet
 * that is not allowed to touch one of them.
 *
 * **That is a seam, and it is recorded rather than left to be discovered:**
 * consolidating the two into one settings section is a job for OPUS-M3-008,
 * which owns composition. It is in `docs/evidence/EV-M3-SETTINGS/INDEX.md`.
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

/**
 * The literal route paths, so TanStack Router can type-check them.
 *
 * Written out rather than assembled from a prefix: the router's `to` is a
 * literal union of the declared route tree, and a template string would
 * type-check as `string` while a typo in a section name became a 404 nobody
 * noticed until somebody clicked it.
 */
const SECTIONS = [
  {
    to: '/organizations/$organizationId/groups/$groupId/settings/group',
    label: 'Group settings',
  },
  {
    to: '/organizations/$organizationId/groups/$groupId/settings/locations',
    label: 'Locations',
  },
] as const;

export function SettingsLayout({
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

      <div className="mx-auto flex min-h-screen w-full min-w-0 max-w-5xl flex-col gap-sp-5 p-sp-4">
        <header>
          <p className="text-sm font-medium uppercase tracking-wide text-text-muted">
            SchedulePoint · Settings
          </p>
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <p className="mt-sp-2 text-text-muted">{description}</p>
        </header>

        <nav aria-label="Settings sections">
          {/* A list, so a screen reader announces the count before reading the
              items. Wrapping keeps the whole navigation reachable at 320px
              without a horizontal scrollbar on the page (SC 1.4.10). */}
          <ul className="flex flex-wrap gap-sp-2">
            {SECTIONS.map((section) => (
              <li key={section.to}>
                <Link
                  activeProps={{ 'aria-current': 'page', className: 'border-accent text-accent' }}
                  className="inline-flex min-h-target items-center rounded-control border border-border px-sp-3 py-sp-2 text-text"
                  params={{ organizationId: scope.organizationId, groupId: scope.groupId }}
                  to={section.to}
                >
                  {section.label}
                </Link>
              </li>
            ))}
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
