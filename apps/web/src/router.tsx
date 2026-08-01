import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
} from '@tanstack/react-router';
import type { JSX } from 'react';

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

const routeTree = rootRoute.addChildren([shellRoute]);

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
