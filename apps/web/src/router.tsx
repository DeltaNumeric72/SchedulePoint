import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
} from '@tanstack/react-router';
import type { JSX } from 'react';

import { GroupSettingsPage } from './catalogue/GroupSettingsPage.js';
import { ShiftGroupsPage, StaffGroupsPage, ValidGroupsPage } from './catalogue/GroupingPages.js';
import {
  ActivationPage,
  MfaChallengePage,
  MfaEnrolmentPage,
  PasswordResetCompletePage,
  PasswordResetRequestPage,
  SignInPage,
} from './authn/pages.js';
import { RulesPage } from './rules/RulesPage.js';
import { GridPage } from './schedule/GridPage.js';
import { PeriodsPage } from './schedule/PeriodsPage.js';
import { ShiftTypesPage } from './catalogue/ShiftTypesPage.js';
import { PublicationReviewPage } from './publication/PublicationReviewPage.js';
import { PublishedSchedulePage } from './publication/PublishedSchedulePage.js';
import { VersionComparisonPage } from './publication/VersionComparisonPage.js';
import { VersionHistoryPage } from './publication/VersionHistoryPage.js';
import { ShellPage } from './shell/ShellPage.js';
import { GroupSettingsPage as SettingsGroupPage } from './settings/GroupSettingsPage.js';
import { LocationsPage } from './settings/LocationsPage.js';

/**
 * TanStack Router, code-based.
 *
 * One route. Code-based rather than file-based routing keeps the scaffold free
 * of a codegen step and keeps the route tree greppable — which matters, because
 * the client route tree will eventually have to be reconciled against the
 * server's policy-checked route table.
 */
function RootLayout(): JSX.Element {
  return <Outlet />;
}

const rootRoute = createRootRoute({ component: RootLayout });

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ShellPage,
});

/**
 * The catalogue routes (OPUS-M2-002).
 *
 * **The declared tenant context is in the path**, not in state: SPEC-01 §2.2
 * requires the client to declare it and the server to verify it, and §3 requires
 * switching it to be explicit and visible rather than inferred. A path carries
 * that through a bookmark, a shared link and a second tab; a session-global
 * "current group" is the CAR-001 defect class, and this is it designed out of
 * the URL space rather than guarded against later.
 *
 * The segments mirror the API's own route shape exactly, so the client route
 * tree and the server's policy-checked route table can eventually be reconciled
 * against each other rather than compared by eye.
 */
const catalogueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/groups/$groupId/catalogue',
  component: RootLayout,
});

/**
 * Each child is declared on its own line rather than mapped from a list.
 *
 * `.map()` produces `Route[]`, and TanStack Router derives the typed `to` union
 * from the TUPLE of children — so a mapped tree type-checks while `to` collapses
 * to `"/"` and every catalogue link becomes a type error at its call site. The
 * repetition is what buys the typed route table.
 */
const shiftTypesRoute = createRoute({
  getParentRoute: () => catalogueRoute,
  path: 'shift-types',
  component: ShiftTypesPage,
});
const shiftGroupsRoute = createRoute({
  getParentRoute: () => catalogueRoute,
  path: 'shift-groups',
  component: ShiftGroupsPage,
});
const staffGroupsRoute = createRoute({
  getParentRoute: () => catalogueRoute,
  path: 'staff-groups',
  component: StaffGroupsPage,
});
const validGroupsRoute = createRoute({
  getParentRoute: () => catalogueRoute,
  path: 'valid-groups',
  component: ValidGroupsPage,
});
const groupSettingsRoute = createRoute({
  getParentRoute: () => catalogueRoute,
  path: 'group-settings',
  component: GroupSettingsPage,
});

/**
 * Rule authoring (OPUS-M3-002).
 *
 * A sibling of the catalogue sections rather than a tree of its own: doc 08 §6
 * puts catalogue and rules on ONE row ("Author catalogue & rules"), they share a
 * capability, and they are the same person's task in the same group. The path
 * mirrors the API's `/organizations/:o/groups/:g/rules` with the catalogue
 * prefix the layout supplies.
 */
const rulesRoute = createRoute({
  getParentRoute: () => catalogueRoute,
  path: 'rules',
  component: RulesPage,
});

/**
 * Group settings and locations (OPUS-M3-007).
 *
 * A sibling TREE of the catalogue's rather than a section inside it, and that is
 * a seam rather than a preference: `catalogue/GroupSettingsPage.tsx` already
 * holds the pick-position count and the holiday calendar at
 * `/catalogue/group-settings`, and packet 32 §10a freezes that file to this
 * packet. The two live at different URLs rather than being merged by a packet
 * that may not touch one of them; consolidating them belongs to OPUS-M3-008,
 * which owns composition, and it is recorded in EV-M3-SETTINGS.
 *
 * The organization and group are PATH segments for the same reason the
 * catalogue's are: SPEC-01 §2.2 requires the client to declare the tenant
 * context and §3 requires switching it to be explicit rather than inferred.
 */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/groups/$groupId/settings',
  component: RootLayout,
});

const settingsGroupRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'group',
  component: SettingsGroupPage,
});

const settingsLocationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'locations',
  component: LocationsPage,
});

/**
 * The authentication surfaces (OPUS-M3-001).
 *
 * **The organization is in the PATH**, for the same reason the catalogue's is:
 * SPEC-01 §2.2 requires the tenant to be declared by the client and §3 requires
 * switching it to be explicit. It mirrors the API's own route shape exactly.
 *
 * **No token is in a path segment.** Activation and reset take their token in a
 * form field: a token in a URL lands in browser history, in a `Referer` header
 * and in every proxy log between the browser and the server, which is precisely
 * what 14 §5's "hash-stored, never exposed" posture exists to prevent.
 */
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/sign-in',
  component: SignInPage,
});
const mfaChallengeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/sign-in/challenge',
  component: MfaChallengePage,
});
const mfaEnrolmentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/sign-in/enrolment',
  component: MfaEnrolmentPage,
});
const activationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/activate',
  component: ActivationPage,
});
const resetRequestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/reset',
  component: PasswordResetRequestPage,
});
const resetCompleteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/reset/complete',
  component: PasswordResetCompletePage,
});

/**
 * The schedule-authoring routes (OPUS-M3-004).
 *
 * A sibling of the catalogue tree rather than a child of it: doc 08 §6 keeps
 * "Author catalogue & rules" and "author the schedule" on separate rows, they
 * carry different capabilities, and the schedule surface has its own navigation.
 * The segments mirror the API's `/organizations/:o/groups/:g/schedule` exactly,
 * so the client route tree and the server's policy-checked route table can be
 * reconciled against each other rather than compared by eye.
 */
const scheduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/groups/$groupId/schedule',
  component: RootLayout,
});
const schedulePeriodsRoute = createRoute({
  getParentRoute: () => scheduleRoute,
  path: 'periods',
  component: PeriodsPage,
});
const scheduleVersionRoute = createRoute({
  getParentRoute: () => scheduleRoute,
  path: 'versions/$versionId',
  component: GridPage,
});

/**
 * The publication and version-management routes (OPUS-M3-005).
 *
 * A sibling TREE of the schedule's rather than a section inside it, for the same
 * reason `settings` is a sibling of `catalogue`: publication is a distinct act
 * under a distinct, grant-only capability (`schedule.publish`, doc 08 §4), and
 * nesting it under the authoring path would put an irreversible act inside a
 * section whose whole frame is about drafting. The segments mirror the API's
 * `/organizations/:o/groups/:g/schedule/...` routes with a `publication` prefix
 * the layout supplies, so the client route tree and the server's policy-checked
 * route table stay reconcilable rather than compared by eye.
 */
const publicationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/organizations/$organizationId/groups/$groupId/publication',
  component: RootLayout,
});
const publishedScheduleRoute = createRoute({
  getParentRoute: () => publicationRoute,
  path: 'periods/$periodId/published',
  component: PublishedSchedulePage,
});
const versionHistoryRoute = createRoute({
  getParentRoute: () => publicationRoute,
  path: 'periods/$periodId/history',
  component: VersionHistoryPage,
});
const publicationReviewRoute = createRoute({
  getParentRoute: () => publicationRoute,
  path: 'versions/$versionId/review',
  component: PublicationReviewPage,
});
const versionComparisonRoute = createRoute({
  getParentRoute: () => publicationRoute,
  path: 'versions/$versionId/comparison',
  component: VersionComparisonPage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  mfaChallengeRoute,
  mfaEnrolmentRoute,
  activationRoute,
  resetRequestRoute,
  resetCompleteRoute,
  shellRoute,
  catalogueRoute.addChildren([
    shiftTypesRoute,
    shiftGroupsRoute,
    staffGroupsRoute,
    validGroupsRoute,
    groupSettingsRoute,
    rulesRoute,
  ]),
  settingsRoute.addChildren([settingsGroupRoute, settingsLocationsRoute]),
  scheduleRoute.addChildren([schedulePeriodsRoute, scheduleVersionRoute]),
  publicationRoute.addChildren([
    publishedScheduleRoute,
    versionHistoryRoute,
    publicationReviewRoute,
    versionComparisonRoute,
  ]),
]);

export function createAppRouter(options: { memory?: boolean } = {}) {
  return createRouter({
    routeTree,
    ...(options.memory === true ? { history: createMemoryHistory({ initialEntries: ['/'] }) } : {}),
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
