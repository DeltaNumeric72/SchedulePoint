import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
} from '@tanstack/react-router';
import type { JSX } from 'react';

import { GroupSettingsPage } from './catalogue/GroupSettingsPage.js';
import {
  ShiftGroupsPage,
  StaffGroupsPage,
  ValidGroupsPage,
} from './catalogue/GroupingPages.js';
import { ShiftTypesPage } from './catalogue/ShiftTypesPage.js';
import { ShellPage } from './shell/ShellPage.js';

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

const routeTree = rootRoute.addChildren([
  shellRoute,
  catalogueRoute.addChildren([
    shiftTypesRoute,
    shiftGroupsRoute,
    staffGroupsRoute,
    validGroupsRoute,
    groupSettingsRoute,
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
